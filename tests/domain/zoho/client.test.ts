import { describe, expect, it, vi, afterEach } from "vitest";
import { describeErpClientContract } from "@/lib/integrations/business/live/contract";
import { ErpNotConfiguredError } from "@/lib/integrations/business/live/errors";
import {
  createZohoInventoryClient,
  zohoAccountsServer,
  zohoFollowUpReference,
  zohoInventoryBaseUrl,
  zohoInventoryProvider,
  ZohoAuthError,
  ZohoRateLimitError,
} from "@/lib/integrations/business/live/zoho";
import { createZohoSimulator, simCredentials, SIM_ORG_ID } from "./simulator";

function setup(limits?: { maxPages?: number; maxDetailReads?: number }) {
  const sim = createZohoSimulator();
  const po = sim.seedPo();
  const client = createZohoInventoryClient({
    credentials: simCredentials,
    clientId: "client-id",
    clientSecret: "client-secret",
    fetch: sim.fetch,
    now: () => new Date("2030-01-08T12:00:00Z"),
    limits,
  });
  return { sim, po, client, lineId: po.line_items[0].line_item_id };
}

const day = (offset: number) => new Date(Date.UTC(2030, 0, 10 + offset, 17)).toISOString();

async function split(env: ReturnType<typeof setup>, changeRef = "action-1") {
  const current = (await env.client.readPurchaseOrder(env.po.purchaseorder_id))!;
  return env.client.applyDeliverySplit({
    change_ref: changeRef,
    po_external_id: env.po.purchaseorder_id,
    line_external_id: env.lineId,
    expected_version: current.version,
    schedules: [
      { quantity: 600, earliest_at: day(1), latest_at: day(1) },
      { quantity: 3400, earliest_at: day(3), latest_at: day(3) },
    ],
  });
}

describe("Zoho Inventory ErpClient contract (MOCKED HTTP simulator, not a real Zoho run)", () => {
  describeErpClientContract(async () => {
    const env = setup();
    return {
      client: env.client,
      poExternalId: env.po.purchaseorder_id,
      lineExternalId: env.lineId,
      touch: async () => env.sim.touch(env.po.purchaseorder_id),
      receive: async (quantity) => {
        await env.sim.receive(env.po.purchaseorder_id, env.lineId, quantity);
      },
    };
  });
});

describe("Zoho Inventory client (mocked HTTP)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("maps snapshot stock per location, open sales-order demand and minor-unit prices", async () => {
    const { client, po } = setup();
    const snapshot = await client.readSnapshot();
    const mapped = snapshot.purchase_orders.find((candidate) => candidate.external_id === po.purchaseorder_id)!;
    expect(mapped).toMatchObject({
      supplier_external_id: "460000000026049",
      currency: "USD",
      version: po.last_modified_time,
    });
    expect(mapped.lines[0]).toMatchObject({
      ordered_qty: 4000,
      received_qty: 0,
      unit_price_minor: "42",
      due_at: "2030-01-14T00:00:00.000Z",
      destination_external_id: "460000000038080",
    });
    expect(snapshot.stock).toEqual([
      { item_external_id: "4815000000044100", location_external_id: "460000000038080", on_hand_qty: 600 },
      { item_external_id: "4815000000044100", location_external_id: "460000000038090", on_hand_qty: 25 },
    ]);
    expect(snapshot.demand).toEqual([{
      external_id: "4815000000045000:4815000000045001",
      item_external_id: "4815000000044100",
      location_external_id: "460000000038080",
      quantity: 800,
      required_at: "2030-01-12T00:00:00.000Z",
      certainty: "confirmed",
    }]);
    expect(snapshot.items[0]).toMatchObject({ sku: "CARTON-302015", unit: "carton" });
    expect(snapshot.suppliers).toEqual([{ external_id: "460000000026049", name: "Bay Carton", email: null, phone: null }]);
  });

  it("sends organization_id and a Zoho-oauthtoken header on every API call", async () => {
    const { client, sim } = setup();
    await client.readSnapshot();
    expect(sim.requests.length).toBeGreaterThan(0);
    for (const request of sim.requests) {
      expect(request.query.get("organization_id")).toBe(SIM_ORG_ID);
      expect(request.authorization).toMatch(/^Zoho-oauthtoken sim-access-/);
    }
  });

  it("splits by shrinking the line, moving the PO date and adding an issued follow-up PO", async () => {
    const env = setup();
    const result = await split(env);
    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    const original = env.sim.pos.get(env.po.purchaseorder_id)!;
    expect(original.line_items[0].quantity).toBe(600);
    expect(original.delivery_date).toBe("2030-01-11");
    expect(original.notes).toContain("Sample Note\nConduit change action-1: ");
    const followUp = [...env.sim.pos.values()].find((po) => po.reference_number === zohoFollowUpReference("action-1", 1))!;
    expect(followUp).toMatchObject({ status: "issued", delivery_date: "2030-01-13", vendor_id: original.vendor_id });
    expect(followUp.line_items[0]).toMatchObject({ quantity: 3400, item_id: "4815000000044100", purchase_rate: 0.42 });
    expect(result.deliveries).toEqual([
      { external_ref: env.lineId, quantity: 600, due_at: "2030-01-11T00:00:00.000Z" },
      { external_ref: `${followUp.purchaseorder_id}:${followUp.line_items[0].line_item_id}`, quantity: 3400, due_at: "2030-01-13T00:00:00.000Z" },
    ]);
    expect(result.version).toBe(original.last_modified_time);
  });

  it("resumes after a timed-out PO update without creating a second follow-up PO", async () => {
    const env = setup();
    env.sim.failNext("PUT", /^\/purchaseorders\/\d+$/, 0, { network: true });
    expect((await split(env)).status).toBe("unknown");
    expect((await env.client.findChange("action-1", env.po.purchaseorder_id)).status).toBe("not_found");
    const retried = await split(env);
    expect(retried.status).toBe("applied");
    expect(env.sim.requests.filter((r) => r.method === "POST" && r.path === "/purchaseorders")).toHaveLength(1);
  });

  it("cancels the follow-up PO when Zoho rejects the original PO update", async () => {
    const env = setup();
    env.sim.failNext("PUT", /^\/purchaseorders\/\d+$/, 400, { body: { code: 4000, message: "Invalid line" } });
    const result = await split(env);
    expect(result).toEqual({ status: "rejected", code: "provider_rejected", message: "Invalid line" });
    const followUp = [...env.sim.pos.values()].find((po) => po.reference_number.startsWith("CDT-"))!;
    expect(followUp.status).toBe("cancelled");
    expect(env.sim.pos.get(env.po.purchaseorder_id)!.line_items[0].quantity).toBe(4000);
  });

  it("refuses PO splits when other lines still share the PO delivery date", async () => {
    const env = setup();
    const po = env.sim.seedPo({}, [{}, { quantity: 10 }]);
    const current = (await env.client.readPurchaseOrder(po.purchaseorder_id))!;
    const result = await env.client.applyDeliverySplit({
      change_ref: "action-2",
      po_external_id: po.purchaseorder_id,
      line_external_id: po.line_items[0].line_item_id,
      expected_version: current.version,
      schedules: [
        { quantity: 1000, earliest_at: day(1), latest_at: day(1) },
        { quantity: 3000, earliest_at: day(3), latest_at: day(3) },
      ],
    });
    expect(result).toMatchObject({ status: "rejected", code: "not_supported_by_provider" });
    expect(env.sim.requests.some((r) => r.method !== "GET")).toBe(false);
  });

  it("rejects schedules that do not cover the open quantity", async () => {
    const env = setup();
    const current = (await env.client.readPurchaseOrder(env.po.purchaseorder_id))!;
    const result = await env.client.applyDeliverySplit({
      change_ref: "action-3",
      po_external_id: env.po.purchaseorder_id,
      line_external_id: env.lineId,
      expected_version: current.version,
      schedules: [{ quantity: 10, earliest_at: day(1), latest_at: day(1) }],
    });
    expect(result).toMatchObject({ status: "rejected", code: "quantity_mismatch" });
  });

  it("refreshes the access token once on 401", async () => {
    const env = setup();
    await env.client.readPurchaseOrder(env.po.purchaseorder_id);
    env.sim.expireTokens();
    expect(await env.client.readPurchaseOrder(env.po.purchaseorder_id)).not.toBeNull();
  });

  it("surfaces Zoho's 429 as a rate-limit error and a rate_limited split rejection", async () => {
    const env = setup();
    env.sim.failNext("GET", /^\/locations$/, 429);
    await expect(env.client.readSnapshot()).rejects.toBeInstanceOf(ZohoRateLimitError);
    const current = (await env.client.readPurchaseOrder(env.po.purchaseorder_id))!;
    env.sim.failNext("GET", /^\/purchaseorders\/\d+$/, 429);
    expect(await env.client.applyDeliverySplit({
      change_ref: "action-429",
      po_external_id: env.po.purchaseorder_id,
      line_external_id: env.lineId,
      expected_version: current.version,
      schedules: [{ quantity: 4000, earliest_at: day(1), latest_at: day(1) }],
    })).toMatchObject({ status: "rejected", code: "rate_limited" });
  });

  it("returns null for unknown POs and not_found for unknown changes", async () => {
    const { client } = setup();
    expect(await client.readPurchaseOrder("999")).toBeNull();
    expect(await client.readPurchaseOrder("../items")).toBeNull();
    expect(await client.findChange("action-x", "999")).toEqual({ status: "not_found" });
  });

  it("fails loudly instead of truncating large snapshots", async () => {
    const env = setup({ maxDetailReads: 1 });
    env.sim.seedPo();
    await expect(env.client.readSnapshot()).rejects.toThrow(/read limit/);
  });

  it("raises ZohoAuthError when the refresh token is revoked", async () => {
    const sim = createZohoSimulator();
    const client = createZohoInventoryClient({
      credentials: { ...simCredentials, refresh_token: "revoked" },
      clientId: "id",
      clientSecret: "secret",
      fetch: sim.fetch,
      now: () => new Date(),
    });
    await expect(client.readPurchaseOrder("1")).rejects.toBeInstanceOf(ZohoAuthError);
  });

  it("provider reports not configured without ZOHO_CLIENT_ID/SECRET and rejects bad credentials", () => {
    vi.stubEnv("ZOHO_CLIENT_ID", "");
    vi.stubEnv("ZOHO_CLIENT_SECRET", "");
    expect(() => zohoInventoryProvider.createClient(simCredentials)).toThrow(ErpNotConfiguredError);
    vi.stubEnv("ZOHO_CLIENT_ID", "id");
    vi.stubEnv("ZOHO_CLIENT_SECRET", "secret");
    expect(() => zohoInventoryProvider.createClient({ refresh_token: "x" })).toThrow(ZohoAuthError);
    expect(() => zohoInventoryProvider.createClient({ ...simCredentials, api_domain: "https://evil.example" }))
      .toThrow(ZohoAuthError);
    expect(zohoInventoryProvider.createClient(simCredentials).provider).toBe("zoho_inventory");
  });

  it("only trusts Zoho data-center domains", () => {
    expect(zohoInventoryBaseUrl("https://api.zoho.eu")).toBe("https://www.zohoapis.eu/inventory/v1");
    expect(zohoInventoryBaseUrl("https://www.zohoapis.com.au")).toBe("https://www.zohoapis.com.au/inventory/v1");
    expect(zohoInventoryBaseUrl("https://www.zohoapis.com.evil.io")).toBeNull();
    expect(zohoInventoryBaseUrl("http://www.zohoapis.com")).toBeNull();
    expect(zohoAccountsServer("https://accounts.zoho.in")).toBe("https://accounts.zoho.in");
    expect(zohoAccountsServer("https://accounts.zohocloud.ca")).toBe("https://accounts.zohocloud.ca");
    expect(zohoAccountsServer("https://accounts.zoho.com@evil.io")).toBeNull();
  });
});
