import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerTransferGate, type TransferGateResult } from "@/lib/actions/live-step";
import { preflightTransferSteps } from "@/lib/actions/transfer-preflight";
import type { Rpc } from "@/lib/actions/rpc";
import { ReplayViolationError } from "@/lib/actions/replay";
import type { ActionRecord } from "@/lib/actions/types";
import type { ProjectionFacts } from "@/lib/domain/assessment-input";
import { prepareLiveTransferPayload } from "@/lib/integrations/business/live/prepare-transfer";
import type { ResolvedErpClient } from "@/lib/integrations/business/live/resolve";
import { shopifyProvider } from "@/lib/integrations/business/live/shopify";
import { evaluateTransferGate } from "@/lib/integrations/business/live/transfer-gate";
import {
  createLiveTransferAdapter,
  liveTransferPayloadSchema,
  outcomeForLookup,
  toTransferRequest,
  type LiveTransferPayload,
} from "@/lib/integrations/business/live/transfer-adapter";
import type { ErpClient, ErpProvider } from "@/lib/integrations/business/live/types";
import { createShopifyEmulator } from "../fixtures/shopify-emulator";

// Mocked: a Shopify emulator behind the real connector and an in-memory ledger RPC. No business system is contacted.
const ITEM_EXT = "gid://shopify/InventoryItem/11";
const SOURCE_EXT = "gid://shopify/Location/3";
const DEST_EXT = "gid://shopify/Location/1";
const CONNECTION = randomUUID();
const ITEM = randomUUID();
const SOURCE = randomUUID();
const DEST = randomUUID();
const WRITE_SCOPE = "read_inventory,write_inventory_transfers,write_inventory_shipments";

const credentials = (scope: string) => ({
  shop: "conduit-dev.myshopify.com",
  access_token: "shpat_test",
  scope,
  access_token_expires_at: null,
  refresh_token: null,
  refresh_token_expires_at: null,
});

function shopifyClient(scope = WRITE_SCOPE, onHand = 500) {
  const shopify = createShopifyEmulator({ now: () => new Date("2030-01-10T12:00:00Z") });
  shopify.setLevel(ITEM_EXT, SOURCE_EXT, { on_hand: onHand });
  return { shopify, client: shopifyProvider.createClient(credentials(scope), { fetch: shopify.fetch }) };
}

const ready = (client: ErpClient, provider: ErpProvider = "shopify"): ResolvedErpClient => ({
  status: "ready",
  client,
  connection: { connectionId: CONNECTION, provider, externalAccountId: "shop", syncCursor: null, lastSuccessAt: null },
});

const payload = (overrides: Partial<LiveTransferPayload> = {}): LiveTransferPayload =>
  liveTransferPayloadSchema.parse({
    change_kind: "transfer_stock",
    source_location_id: SOURCE,
    arrival_end: "2030-01-12T17:00:00.000Z",
    transfer_cost_minor: "2500",
    item_id: ITEM,
    destination_location_id: DEST,
    quantity: 50,
    erp: {
      connection_id: CONNECTION,
      provider: "shopify",
      item_external_id: ITEM_EXT,
      source_location_external_id: SOURCE_EXT,
      destination_location_external_id: DEST_EXT,
      min_source_on_hand_after: 450,
      source_max_safe_qty: 50,
      source_physical_qty: 500,
      source_as_of: "2030-01-10T00:00:00.000Z",
    },
    ...overrides,
  });

const action = (overrides: Partial<ActionRecord> = {}): ActionRecord => ({
  id: randomUUID(),
  orgId: randomUUID(),
  caseId: randomUUID(),
  kind: "live_business_transfer",
  idempotencyKey: "plan:p:v1:step:transfer-1",
  payloadHash: "h",
  payload: payload(),
  contactId: null,
  providerRef: null,
  mode: "sandbox",
  ...overrides,
});

describe("live transfer adapter", () => {
  it("pins the action id as the provider change reference and carries the approved stock floor", () => {
    expect(toTransferRequest("act-1", payload())).toEqual({
      change_ref: "act-1",
      item_external_id: ITEM_EXT,
      source_location_external_id: SOURCE_EXT,
      destination_location_external_id: DEST_EXT,
      quantity: 50,
      arrives_at: "2030-01-12T17:00:00.000Z",
      min_source_on_hand_after: 450,
    });
  });

  it("confirms only a dispatched transfer, and keeps the provider reference as evidence", async () => {
    const { shopify, client } = shopifyClient();
    const a = action();
    const adapter = createLiveTransferAdapter({ resolve: async () => ready(client) });
    const result = await adapter.dispatch(a);

    expect(result).toMatchObject({ outcome: "confirmed" });
    expect(result.providerRef).toMatch(/^gid:\/\/shopify\/InventoryTransfer\/\d+#CDT-/);
    expect(result.safeSummary).toContain("50 units dispatched and in transit");
    expect(shopify.level(ITEM_EXT, SOURCE_EXT)?.on_hand).toBe(450);
    expect(await adapter.findResult({ ...a, providerRef: result.providerRef ?? null })).toMatchObject({ outcome: "confirmed" });
  });

  it("does not write when stock changed since approval, and says so", async () => {
    const { shopify, client } = shopifyClient(WRITE_SCOPE, 480);
    const result = await createLiveTransferAdapter({ resolve: async () => ready(client) }).dispatch(action());

    expect(result).toMatchObject({ outcome: "failed", errorCode: "source_stock_changed" });
    expect(shopify.transfers).toHaveLength(0);
  });

  it("reports an ambiguous write as unknown and settles it by reading, never writing again", async () => {
    const { shopify, client } = shopifyClient();
    const a = action();
    const adapter = createLiveTransferAdapter({ resolve: async () => ready(client) });
    shopify.failNext("ConduitShipmentCreateInTransit", "drop_response");

    expect(await adapter.dispatch(a)).toMatchObject({ outcome: "unknown" });
    const writesBefore = shopify.requests.filter((r) => r.operationName.startsWith("ConduitTransferCreate") || r.operationName.startsWith("ConduitShipmentCreate")).length;
    expect(await adapter.findResult(a)).toMatchObject({ outcome: "confirmed" });
    const writesAfter = shopify.requests.filter((r) => r.operationName.startsWith("ConduitTransferCreate") || r.operationName.startsWith("ConduitShipmentCreate")).length;
    expect(writesAfter).toBe(writesBefore);
    expect(shopify.transfers).toHaveLength(1);
  });

  it("stays unknown while Shopify shows the transfer reserved but not dispatched", async () => {
    const { shopify, client } = shopifyClient();
    const a = action();
    const adapter = createLiveTransferAdapter({ resolve: async () => ready(client) });
    shopify.failNext("ConduitShipmentCreateInTransit", { code: "INVALID", message: "rejected" });

    expect(await adapter.dispatch(a)).toMatchObject({ outcome: "unknown" });
    const found = await adapter.findResult(a);
    expect(found).toMatchObject({ outcome: "unknown" });
    expect(found.safeSummary).toContain("reserved at the source, not dispatched");
  });

  it("maps what the system shows to ledger outcomes", () => {
    const record = { provider_ref: "t#CDT-x", transfer_external_id: "t", shipment_external_id: "s", quantity: 50, received_qty: 0, arrives_at: null };
    expect(outcomeForLookup({ status: "not_found" }, "Shopify")).toMatchObject({ outcome: "unknown" });
    expect(outcomeForLookup({ status: "found", state: "reserved", ...record }, "Shopify")).toMatchObject({ outcome: "unknown" });
    expect(outcomeForLookup({ status: "found", state: "in_transit", ...record }, "Shopify")).toMatchObject({ outcome: "confirmed", providerRef: "t#CDT-x" });
    expect(outcomeForLookup({ status: "found", state: "partially_received", ...record, received_qty: 10 }, "Shopify")).toMatchObject({ outcome: "confirmed" });
    expect(outcomeForLookup({ status: "found", state: "received", ...record, received_qty: 50 }, "Shopify")).toMatchObject({ outcome: "confirmed" });
    expect(outcomeForLookup({ status: "found", state: "cancelled", ...record }, "Shopify")).toMatchObject({ outcome: "failed", errorCode: "transfer_cancelled" });
  });

  it("fails without writing when the provider cannot execute transfers or is unreachable", async () => {
    const { client } = shopifyClient("read_inventory");
    expect(client.transfers).toBeUndefined();
    expect(await createLiveTransferAdapter({ resolve: async () => ready(client) }).dispatch(action())).toMatchObject({
      outcome: "failed",
      errorCode: "transfer_not_supported",
    });
    const down = createLiveTransferAdapter({ resolve: async () => ({ status: "not_connected", connection: null, reason: "No business system is connected" }) });
    expect(await down.dispatch(action())).toMatchObject({ outcome: "failed", errorCode: "connection_unavailable" });
    expect(await down.findResult(action())).toMatchObject({ outcome: "unknown" });
  });

  it("maps provider rejection and exceptions honestly", async () => {
    const { client } = shopifyClient();
    const withApi = (createTransfer: unknown) =>
      createLiveTransferAdapter({ resolve: async () => ready({ ...client, transfers: { ...client.transfers!, createTransfer: createTransfer as never } }) });
    expect(await withApi(async () => ({ status: "rejected", code: "locked", message: "x" })).dispatch(action())).toMatchObject({
      outcome: "failed",
      errorCode: "erp_rejected",
    });
    expect(await withApi(async () => ({ status: "unknown", message: "timeout" })).dispatch(action())).toMatchObject({ outcome: "unknown" });
  });

  it("refuses replay actions before resolving a client", async () => {
    const resolve = vi.fn();
    const adapter = createLiveTransferAdapter({ resolve });
    await expect(adapter.dispatch(action({ mode: "replay" }))).rejects.toBeInstanceOf(ReplayViolationError);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("rejects payloads that carry anything beyond the approved terms", () => {
    expect(() => liveTransferPayloadSchema.parse({ ...payload(), extra: true })).toThrow();
    expect(() => liveTransferPayloadSchema.parse({ ...payload(), quantity: 0 })).toThrow();
    expect(() => payload({ erp: { ...payload().erp, provider: "ebay" as ErpProvider } })).toThrow();
  });
});

describe("transfer gate", () => {
  const resolver = (resolved: ResolvedErpClient) => async () => resolved;

  it("executes only when the connection can reserve, dispatch and read back", async () => {
    const { client } = shopifyClient();
    expect(await evaluateTransferGate(resolver(ready(client)), "org")).toEqual({ mode: "execute", provider: "shopify", connectionId: CONNECTION });
  });

  it("explains why Shopify stays recommend-only without the transfer permission", async () => {
    const { client } = shopifyClient("read_inventory,write_inventory_shipments");
    expect(await evaluateTransferGate(resolver(ready(client)), "org")).toMatchObject({
      mode: "recommend_only",
      provider: "shopify",
      code: "transfer_permission_missing",
    });
  });

  it("keeps every other provider recommend-only with a documented reason", async () => {
    for (const provider of ["odoo", "zoho_inventory", "quickbooks"] as const) {
      const { client } = shopifyClient();
      const result = await evaluateTransferGate(resolver(ready({ ...client, provider }, provider)), "org");
      expect(result).toMatchObject({ mode: "recommend_only", provider, code: "provider_unsupported" });
    }
  });

  it("reports a missing connection instead of throwing", async () => {
    const result = await evaluateTransferGate(resolver({ status: "not_connected", connection: null, reason: "No business system is connected" }), "org");
    expect(result).toEqual({ mode: "recommend_only", provider: null, code: "not_connected", reason: "No business system is connected" });
  });
});

function facts(physical: number, demandQty = 450): ProjectionFacts {
  return {
    dataset: { id: randomUUID(), source_type: "connector", source_as_of: "2030-01-10T00:00:00Z", content_hash: "h" },
    item: { id: ITEM, base_unit: "each", specification: {} },
    location: { id: SOURCE, timezone: "UTC" },
    inventory: { id: randomUUID(), physical_qty: physical, unusable_qty: 0, outside_allocations_qty: 0, source_as_of: "2030-01-10T00:00:00Z" },
    demand: [{ id: randomUUID(), external_id: "d", remaining_qty: demandQty, required_at: "2030-01-13T15:00:00Z", certainty: "confirmed", included_reserved_qty: 0, source_as_of: "2030-01-10T00:00:00Z" }],
    receipts: [],
    lines: [],
    claims: [],
  };
}

function ledgerRpc(overrides: { facts?: ProjectionFacts; ref?: unknown; sync?: () => unknown } = {}) {
  const calls: string[] = [];
  const rpc: Rpc = async (fn) => {
    calls.push(fn);
    switch (fn) {
      case "erp_activate_snapshot":
        if (overrides.sync) return overrides.sync();
        return { outcome: "noop_same_content", dataset_id: randomUUID() };
      case "erp_transfer_ref":
        return "ref" in overrides
          ? overrides.ref
          : {
              item_external_id: ITEM_EXT,
              source_location_external_id: SOURCE_EXT,
              destination_location_external_id: DEST_EXT,
              connection_id: CONNECTION,
            };
      case "load_projection_facts":
        return overrides.facts ?? facts(500);
      default:
        throw new Error(`unexpected rpc ${fn}`);
    }
  };
  return { rpc, calls };
}

const step = { kind: "transfer_stock", quantity: 50, item_id: ITEM, destination_location_id: DEST };
const stepPayload = { source_location_id: SOURCE, arrival_end: "2030-01-12T17:00:00.000Z", transfer_cost_minor: "2500" };

function prepareDeps(rpc: Rpc, resolved: ResolvedErpClient) {
  return { rpc, clock: { now: () => new Date("2030-01-10T12:00:00Z") }, resolve: async () => resolved };
}

describe("prepareLiveTransferPayload (freshness recheck before execute)", () => {
  it("refreshes the snapshot, re-checks the source, and pins identities and the stock floor", async () => {
    const { client } = shopifyClient();
    const { rpc, calls } = ledgerRpc();
    const result = await prepareLiveTransferPayload(prepareDeps(rpc, ready(client)), { orgId: "org", stepPayload, step });

    expect(calls.indexOf("erp_activate_snapshot")).toBeLessThan(calls.indexOf("load_projection_facts"));
    expect(result).toMatchObject({
      ok: true,
      payload: {
        quantity: 50,
        destination_location_id: DEST,
        erp: {
          provider: "shopify",
          item_external_id: ITEM_EXT,
          source_location_external_id: SOURCE_EXT,
          destination_location_external_id: DEST_EXT,
          min_source_on_hand_after: 450,
          source_max_safe_qty: 50,
          source_physical_qty: 500,
        },
      },
    });
  });

  it("refuses when the refreshed source can no longer spare the approved quantity", async () => {
    const { client } = shopifyClient();
    const { rpc } = ledgerRpc({ facts: facts(470) });
    const result = await prepareLiveTransferPayload(prepareDeps(rpc, ready(client)), { orgId: "org", stepPayload, step });

    expect(result).toMatchObject({ ok: false, code: "failed_precondition", reason: "source_coverage_insufficient" });
    expect(result.ok === false && result.message).toContain("only 20");
  });

  it("refuses when source stock is unknown in the refreshed data", async () => {
    const { client } = shopifyClient();
    const { rpc } = ledgerRpc({ facts: { ...facts(500), inventory: null } });
    expect(await prepareLiveTransferPayload(prepareDeps(rpc, ready(client)), { orgId: "org", stepPayload, step })).toMatchObject({
      ok: false,
      reason: "source_facts_incomplete",
    });
  });

  it("refuses when the connection cannot execute transfers, before refreshing anything", async () => {
    const { client } = shopifyClient("read_inventory");
    const { rpc, calls } = ledgerRpc();
    expect(await prepareLiveTransferPayload(prepareDeps(rpc, ready(client)), { orgId: "org", stepPayload, step })).toMatchObject({
      ok: false,
      reason: "transfer_unsupported",
    });
    expect(calls).toEqual([]);
  });

  it("refuses locations that did not come from the connected system, or a failed refresh", async () => {
    const { client } = shopifyClient();
    for (const rpcCase of [ledgerRpc({ ref: null }), ledgerRpc({ ref: { item_external_id: "i", source_location_external_id: "s", destination_location_external_id: "d", connection_id: randomUUID() } })]) {
      expect(await prepareLiveTransferPayload(prepareDeps(rpcCase.rpc, ready(client)), { orgId: "org", stepPayload, step })).toMatchObject({
        ok: false,
        reason: "not_from_connection",
      });
    }
    const failing = ledgerRpc({ sync: () => { throw new Error("db down"); } });
    expect(await prepareLiveTransferPayload(prepareDeps(failing.rpc, ready(client)), { orgId: "org", stepPayload, step })).toMatchObject({
      ok: false,
      reason: "refresh_failed",
    });
  });

  it("rejects an invalid step or a source equal to the destination", async () => {
    const { client } = shopifyClient();
    const { rpc } = ledgerRpc();
    const deps = prepareDeps(rpc, ready(client));
    expect(await prepareLiveTransferPayload(deps, { orgId: "org", stepPayload, step: { ...step, quantity: null } })).toMatchObject({ ok: false, code: "validation_failed" });
    expect(await prepareLiveTransferPayload(deps, { orgId: "org", stepPayload: { ...stepPayload, transfer_cost_minor: "1.5" }, step })).toMatchObject({ ok: false, code: "validation_failed" });
    expect(await prepareLiveTransferPayload(deps, { orgId: "org", stepPayload, step: { ...step, destination_location_id: SOURCE } })).toMatchObject({ ok: false, code: "validation_failed" });
  });
});

describe("preflightTransferSteps (plan creation)", () => {
  afterEach(() => registerTransferGate(null));
  const planStep = (overrides: Record<string, unknown> = {}) => ({
    step_id: "transfer-1",
    kind: "transfer_stock",
    quantity: 50,
    item_id: ITEM,
    destination_location_id: DEST,
    execution_mode: "live_connector" as const,
    payload: stepPayload,
    ...overrides,
  });
  const gate = (result: TransferGateResult) => registerTransferGate(async () => result);

  it("passes a transfer the source can spare and the connector can run", async () => {
    gate({ mode: "execute", provider: "shopify", connectionId: CONNECTION });
    expect(await preflightTransferSteps(ledgerRpc(), "org", [planStep()])).toBeNull();
  });

  it("refuses a transfer that would shortchange the source, even as a manual recommendation", async () => {
    const result = await preflightTransferSteps(ledgerRpc(), "org", [planStep({ quantity: 51, execution_mode: "manual" })]);
    expect(result).toMatchObject({ ok: false, code: "validation_failed", reason: "source_coverage_insufficient", max_safe_quantity: 50 });
  });

  it("refuses a live step when the connected system cannot execute it, naming the reason", async () => {
    gate({ mode: "recommend_only", provider: "odoo", code: "provider_unsupported", reason: "The Odoo connector does not create internal transfers." });
    const result = await preflightTransferSteps(ledgerRpc(), "org", [planStep()]);
    expect(result).toMatchObject({ ok: false, code: "unsupported_step", reason: "provider_unsupported" });
    expect(result && "message" in result && result.message).toContain("Odoo connector does not create internal transfers");
  });

  it("lets a manual transfer through without asking the connector", async () => {
    const asked = vi.fn(async () => ({ mode: "execute", provider: "shopify", connectionId: CONNECTION }) as TransferGateResult);
    registerTransferGate(asked);
    expect(await preflightTransferSteps(ledgerRpc(), "org", [planStep({ execution_mode: "manual" })])).toBeNull();
    expect(asked).not.toHaveBeenCalled();
  });

  it("refuses a live step when no connector is registered, and incomplete steps", async () => {
    expect(await preflightTransferSteps(ledgerRpc(), "org", [planStep()])).toMatchObject({ ok: false, code: "unsupported_step", reason: "no_connector" });
    expect(await preflightTransferSteps(ledgerRpc(), "org", [planStep({ payload: {} })])).toMatchObject({ ok: false, code: "validation_failed" });
    expect(await preflightTransferSteps(ledgerRpc(), "org", [planStep({ payload: { ...stepPayload, source_location_id: DEST } })])).toMatchObject({ ok: false, code: "validation_failed" });
  });

  it("ignores steps that are not transfers", async () => {
    const rpc = ledgerRpc();
    expect(await preflightTransferSteps(rpc, "org", [planStep({ kind: "amend_delivery_schedule", payload: {} })])).toBeNull();
    expect(rpc.calls).toEqual([]);
  });
});
