import { describe, expect, it } from "vitest";
import { describeErpClientContract } from "@/lib/integrations/business/live/contract";
import { shopifyProvider } from "@/lib/integrations/business/live/shopify";
import { changeStamp } from "@/lib/integrations/business/live/shopify/client";
import { createShopifyEmulator } from "../fixtures/shopify-emulator";

const credentials = {
  shop: "conduit-dev.myshopify.com",
  access_token: "shpat_test",
  scope: "read_inventory",
  access_token_expires_at: null,
  refresh_token: null,
  refresh_token_expires_at: null,
};

function setupClient() {
  const shopify = createShopifyEmulator();
  const client = shopifyProvider.createClient(credentials, { fetch: shopify.fetch });
  return { shopify, client };
}

const day = (d: number) => new Date(Date.UTC(2030, 0, 10 + d, 17)).toISOString();

// Mocked HTTP only: this proves the mapping against documented shapes, not a real Shopify store.
describe("Shopify ErpClient contract (mocked Admin GraphQL)", () => {
  describeErpClientContract(async () => {
    const { shopify, client } = setupClient();
    const { transferId, lineId } = shopify.addTransfer({ quantity: 4000 });
    return {
      client,
      poExternalId: transferId,
      lineExternalId: lineId,
      receive: async (quantity) => shopify.receive(transferId, quantity),
      touch: async () => shopify.touch(transferId),
    };
  });
});

describe("Shopify ErpClient (mocked Admin GraphQL)", () => {
  it("rejects credentials that are not a myshopify.com shop", () => {
    expect(() => shopifyProvider.createClient({ ...credentials, shop: "evil.example.com" })).toThrow();
  });

  it("sends versioned requests with the access token header", async () => {
    const { shopify, client } = setupClient();
    await client.readPurchaseOrder("gid://shopify/InventoryTransfer/404");
    expect(shopify.requests[0].url).toBe("https://conduit-dev.myshopify.com/admin/api/2026-10/graphql.json");
    expect(shopify.requests[0].headers["x-shopify-access-token"]).toBe("shpat_test");
  });

  it("maps locations, tracked items, on-hand stock, open demand and supplier transfers", async () => {
    const { shopify, client } = setupClient();
    const { transferId } = shopify.addTransfer({ quantity: 4000 });
    shopify.addTransfer({ quantity: 50, originLocationId: "gid://shopify/Location/2" });
    shopify.addTransfer({ quantity: 10, status: "CANCELED" });
    const snapshot = await client.readSnapshot();

    expect(snapshot.locations).toEqual([{ external_id: "gid://shopify/Location/1", name: "Main warehouse" }]);
    expect(snapshot.items).toEqual([
      { external_id: "gid://shopify/InventoryItem/11", sku: "BOLT-M8", name: "M8 bolt - Default Title", unit: "each" },
    ]);
    expect(snapshot.stock).toEqual([
      { item_external_id: "gid://shopify/InventoryItem/11", location_external_id: "gid://shopify/Location/1", on_hand_qty: 240, unusable_qty: 5 },
    ]);
    expect(snapshot.demand).toEqual([
      {
        external_id: "gid://shopify/FulfillmentOrderLineItem/41",
        item_external_id: "gid://shopify/InventoryItem/11",
        location_external_id: "gid://shopify/Location/1",
        quantity: 500,
        required_at: "2030-01-12T17:00:00.000Z",
        certainty: "confirmed",
      },
    ]);
    expect(snapshot.purchase_orders.map((p) => p.external_id)).toEqual([transferId]);
    const [po] = snapshot.purchase_orders;
    expect(po).toMatchObject({ supplier_external_id: "shopify-supplier:acme-fasteners", currency: "USD", status: "ready_to_ship" });
    expect(po.lines[0]).toMatchObject({ ordered_qty: 4000, received_qty: 0, unit_price_minor: "42", due_at: null });
    expect(snapshot.suppliers).toEqual([{ external_id: "shopify-supplier:acme-fasteners", name: "Acme Fasteners" }]);
  });

  it("writes one dated, stamped shipment per delivery with idempotency keys", async () => {
    const { shopify, client } = setupClient();
    const { transferId, lineId } = shopify.addTransfer({ quantity: 4000 });
    const po = (await client.readPurchaseOrder(transferId))!;
    const result = await client.applyDeliverySplit({
      change_ref: "action-1",
      po_external_id: transferId,
      line_external_id: lineId,
      expected_version: po.version,
      schedules: [
        { quantity: 600, earliest_at: day(0), latest_at: day(0) },
        { quantity: 3400, earliest_at: day(2), latest_at: day(2) },
      ],
    });
    expect(result).toMatchObject({ status: "applied", provider_ref: `${transferId}#${changeStamp("action-1")}` });
    const creates = shopify.requests.filter((r) => r.operationName === "ConduitShipmentCreate");
    expect(creates.map((r) => (r.variables.input as { barcode: string }).barcode)).toEqual([
      `${changeStamp("action-1")}-1of2`,
      `${changeStamp("action-1")}-2of2`,
    ]);
    expect(new Set(creates.map((r) => r.variables.idempotencyKey)).size).toBe(2);
    expect(creates[0].query).toContain("@idempotent(key: $idempotencyKey)");
    const after = (await client.readPurchaseOrder(transferId))!;
    expect(after.lines[0].due_at).toBe(day(0));
  });

  it("rejects draft transfers and Shopify user errors without claiming success", async () => {
    const { shopify, client } = setupClient();
    const draft = shopify.addTransfer({ quantity: 10, status: "DRAFT" });
    const draftPo = (await client.readPurchaseOrder(draft.transferId))!;
    const draftResult = await client.applyDeliverySplit({
      change_ref: "a-draft",
      po_external_id: draft.transferId,
      line_external_id: draft.lineId,
      expected_version: draftPo.version,
      schedules: [{ quantity: 10, earliest_at: day(0), latest_at: day(0) }],
    });
    expect(draftResult).toMatchObject({ status: "rejected", code: "transfer_not_ready" });

    const open = shopify.addTransfer({ quantity: 10 });
    const openPo = (await client.readPurchaseOrder(open.transferId))!;
    shopify.failNextCreate({ code: "LOCATION_NOT_ACTIVE", message: "Location is not active" });
    const failed = await client.applyDeliverySplit({
      change_ref: "a-user-error",
      po_external_id: open.transferId,
      line_external_id: open.lineId,
      expected_version: openPo.version,
      schedules: [{ quantity: 10, earliest_at: day(0), latest_at: day(0) }],
    });
    expect(failed).toMatchObject({ status: "rejected", code: "shopify_location_not_active" });
  });

  it("rejects splits that do not cover the open quantity", async () => {
    const { shopify, client } = setupClient();
    const { transferId, lineId } = shopify.addTransfer({ quantity: 10 });
    const po = (await client.readPurchaseOrder(transferId))!;
    const result = await client.applyDeliverySplit({
      change_ref: "a-short",
      po_external_id: transferId,
      line_external_id: lineId,
      expected_version: po.version,
      schedules: [{ quantity: 4, earliest_at: day(0), latest_at: day(0) }],
    });
    expect(result).toMatchObject({ status: "rejected", code: "quantity_mismatch" });
  });

  it("reports unknown on a lost response, then finds and completes the change on retry", async () => {
    const { shopify, client } = setupClient();
    const { transferId, lineId } = shopify.addTransfer({ quantity: 10 });
    const po = (await client.readPurchaseOrder(transferId))!;
    const request = {
      change_ref: "a-timeout",
      po_external_id: transferId,
      line_external_id: lineId,
      expected_version: po.version,
      schedules: [
        { quantity: 4, earliest_at: day(0), latest_at: day(0) },
        { quantity: 6, earliest_at: day(1), latest_at: day(1) },
      ],
    };
    shopify.failNextCreate("network");
    expect((await client.applyDeliverySplit(request)).status).toBe("unknown");
    expect(await client.findChange("a-timeout", transferId)).toEqual({ status: "not_found" });

    const retry = await client.applyDeliverySplit(request);
    expect(retry.status).toBe("applied");
    if (retry.status === "applied") expect(retry.deliveries.map((d) => d.quantity)).toEqual([4, 6]);
    expect(shopify.transfers[0].shipments.nodes).toHaveLength(2);
  });

  it("throws on GraphQL errors such as throttling instead of returning data", async () => {
    const client = shopifyProvider.createClient(credentials, {
      fetch: (async () => Response.json({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] })) as typeof fetch,
    });
    await expect(client.readSnapshot()).rejects.toMatchObject({ code: "THROTTLED", retryable: true });
  });

  it("lists accepted shipment quantities as receipts since a timestamp", async () => {
    const { shopify, client } = setupClient();
    const { transferId, lineId } = shopify.addTransfer({ quantity: 10 });
    shopify.receive(transferId, 3);
    const receipts = await client.listReceipts(new Date(Date.now() - 60_000).toISOString());
    expect(receipts).toEqual([
      expect.objectContaining({ po_external_id: transferId, line_external_id: lineId, quantity: 3, kind: "received" }),
    ]);
    expect(await client.listReceipts(new Date(Date.now() + 60_000).toISOString())).toEqual([]);
  });

  it("refreshes an expired access token before calling Shopify", async () => {
    const shopify = createShopifyEmulator();
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/admin/oauth/access_token")) {
        expect(String(init?.body)).toContain("grant_type=refresh_token");
        return Response.json({ access_token: "shpat_new", scope: "read_inventory", expires_in: 3600, refresh_token: "shprt_new", refresh_token_expires_in: 7776000 });
      }
      return shopify.fetch(input, init);
    }) as typeof fetch;
    process.env.SHOPIFY_CLIENT_ID = "cid";
    process.env.SHOPIFY_CLIENT_SECRET = "secret";
    try {
      const client = shopifyProvider.createClient(
        { ...credentials, access_token_expires_at: "2020-01-01T00:00:00Z", refresh_token: "shprt_old" },
        { fetch: fetchImpl },
      );
      await client.readPurchaseOrder("gid://shopify/InventoryTransfer/404");
      await client.readPurchaseOrder("gid://shopify/InventoryTransfer/404");
    } finally {
      delete process.env.SHOPIFY_CLIENT_ID;
      delete process.env.SHOPIFY_CLIENT_SECRET;
    }
    expect(calls.filter((c) => c.endsWith("/admin/oauth/access_token"))).toHaveLength(1);
    expect(shopify.requests.at(-1)?.headers["x-shopify-access-token"]).toBe("shpat_new");
  });
});
