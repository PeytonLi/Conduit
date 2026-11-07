import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ReplayViolationError } from "@/lib/actions/replay";
import type { ActionRecord } from "@/lib/actions/types";
import { encryptCredential } from "@/lib/integrations/gmail/crypto";
import { createLiveBusinessAdapter, toDeliverySplitRequest, liveAmendmentPayloadSchema } from "@/lib/integrations/business/live/adapter";
import { availableBusinessSystems } from "@/lib/integrations/business/live/availability";
import { createFakeErpClient } from "@/lib/integrations/business/live/fake";
import { registerErpProvider, resetErpProvidersForTest } from "@/lib/integrations/business/live/registry";
import { resolveErpClient, type ResolvedErpClient } from "@/lib/integrations/business/live/resolve";
import { normalizeSnapshot, snapshotContentHash } from "@/lib/integrations/business/live/sync";
import type { ErpClient, ErpSnapshot } from "@/lib/integrations/business/live/types";

// Mocked: in-memory fake ErpClient only; no business system is contacted.
const KEY = `v1:${randomBytes(32).toString("base64")}`;
const CONNECTION = randomUUID();

const snapshot = (): ErpSnapshot => ({
  as_of: "2030-01-10T00:00:00.000Z",
  locations: [{ external_id: "wh-1", name: "Main" }],
  items: [{ external_id: "item-1", sku: "CTN", name: "Carton", unit: "carton" }],
  suppliers: [{ external_id: "sup-1", name: "Bay Carton" }],
  purchase_orders: [
    {
      external_id: "PO-1",
      supplier_external_id: "sup-1",
      currency: "USD",
      status: "open",
      version: "v0",
      lines: [
        {
          external_line_id: "PO-1-1",
          item_external_id: "item-1",
          ordered_qty: 4000,
          received_qty: 0,
          unit_price_minor: "42",
          due_at: "2030-01-14T17:00:00.000Z",
          destination_external_id: "wh-1",
        },
      ],
    },
  ],
  stock: [{ item_external_id: "item-1", location_external_id: "wh-1", on_hand_qty: 600 }],
  demand: [],
});

const payload = {
  change_kind: "amend_delivery_schedule",
  po_line_id: randomUUID(),
  receipt_schedule_id: randomUUID(),
  supplier_confirmation_evidence_id: randomUUID(),
  added_cost_minor: "0",
  demand_ids: [],
  schedules: [
    { quantity: 600, earliest_at: "2030-01-12T13:00:00.000Z", latest_at: "2030-01-12T15:00:00.000Z" },
    { quantity: 3400, earliest_at: "2030-01-15T13:00:00.000Z", latest_at: "2030-01-15T15:00:00.000Z" },
  ],
  erp: { connection_id: CONNECTION, provider: "odoo", po_external_id: "PO-1", line_external_id: "PO-1-1", expected_version: "v0" },
};

const action = (mode: ActionRecord["mode"] = "sandbox"): ActionRecord => ({
  id: randomUUID(),
  orgId: randomUUID(),
  caseId: randomUUID(),
  kind: "live_business_amendment",
  idempotencyKey: "k",
  payloadHash: "h",
  payload,
  contactId: null,
  providerRef: null,
  mode,
});

function adapterFor(client: ErpClient) {
  const ready: ResolvedErpClient = {
    status: "ready",
    client,
    connection: { connectionId: CONNECTION, provider: "odoo", externalAccountId: "db", syncCursor: null, lastSuccessAt: null },
  };
  const resolve = vi.fn(async () => ready);
  return { adapter: createLiveBusinessAdapter({ resolve }), resolve };
}

describe("live business amendment adapter (fake ErpClient)", () => {
  it("maps the amendment to a delivery split keyed by the action id", () => {
    const parsed = liveAmendmentPayloadSchema.parse(payload);
    expect(toDeliverySplitRequest("act-1", parsed)).toEqual({
      change_ref: "act-1",
      po_external_id: "PO-1",
      line_external_id: "PO-1-1",
      expected_version: "v0",
      schedules: payload.schedules,
    });
  });

  it("confirms only after the change reads back", async () => {
    const fake = createFakeErpClient({ snapshot: snapshot() });
    const a = action();
    const result = await adapterFor(fake.client).adapter.dispatch(a);
    expect(result).toMatchObject({ outcome: "confirmed", providerRef: `fake:${a.id}` });
    expect(await adapterFor(fake.client).adapter.findResult(a)).toMatchObject({ outcome: "confirmed" });
  });

  it("stays unknown when the write is accepted but not visible", async () => {
    const fake = createFakeErpClient({ snapshot: snapshot() });
    const client = { ...fake.client, findChange: async () => ({ status: "not_found" as const }) };
    expect(await adapterFor(client).adapter.dispatch(action())).toMatchObject({ outcome: "unknown" });
  });

  it("does not write when the PO version moved", async () => {
    const fake = createFakeErpClient({ snapshot: snapshot() });
    fake.touch("PO-1");
    const apply = vi.spyOn(fake.client, "applyDeliverySplit");
    expect(await adapterFor(fake.client).adapter.dispatch(action())).toMatchObject({ outcome: "failed", errorCode: "erp_conflict" });
    expect(apply).not.toHaveBeenCalled();
  });

  it("reports provider conflict, rejection and ambiguity honestly", async () => {
    const fake = createFakeErpClient({ snapshot: snapshot() });
    const withResult = (r: unknown) => adapterFor({ ...fake.client, applyDeliverySplit: async () => r as never }).adapter;
    expect(await withResult({ status: "conflict", current_version: "v9", message: "x" }).dispatch(action())).toMatchObject({
      outcome: "failed",
      errorCode: "erp_conflict",
    });
    expect(await withResult({ status: "rejected", code: "locked", message: "x" }).dispatch(action())).toMatchObject({
      outcome: "failed",
      errorCode: "erp_rejected",
    });
    expect(await withResult({ status: "unknown", message: "timeout" }).dispatch(action())).toMatchObject({ outcome: "unknown" });
  });

  it("hands a not_supported_by_provider rejection to manual execution", async () => {
    const fake = createFakeErpClient({ snapshot: snapshot() });
    const client = {
      ...fake.client,
      applyDeliverySplit: async () => ({ status: "rejected" as const, code: "not_supported_by_provider", message: "read-only" }),
    };
    expect(await adapterFor(client).adapter.dispatch(action())).toMatchObject({
      outcome: "submitted",
      errorCode: "not_supported_by_provider",
    });
  });

  it("fails without writing when no business system is connected", async () => {
    const adapter = createLiveBusinessAdapter({
      resolve: async () => ({ status: "not_connected", connection: null, reason: "No business system is connected" }),
    });
    expect(await adapter.dispatch(action())).toMatchObject({ outcome: "failed", errorCode: "connection_unavailable" });
  });

  it("refuses replay actions before resolving a client", async () => {
    const { adapter, resolve } = adapterFor(createFakeErpClient({ snapshot: snapshot() }).client);
    await expect(adapter.dispatch(action("replay"))).rejects.toBeInstanceOf(ReplayViolationError);
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("resolveErpClient", () => {
  const row = (extra: Record<string, unknown> = {}) => ({
    connection_id: CONNECTION,
    provider: "quickbooks",
    status: "healthy",
    external_account_id: "realm-1",
    sync_cursor: null,
    last_success_at: null,
    encrypted_b64: encryptCredential(JSON.stringify({ refresh_token: "r" }), KEY),
    key_version: "v1",
    ...extra,
  });
  const rpc = (value: unknown) => vi.fn(async () => value);

  it("returns structured states instead of throwing", async () => {
    resetErpProvidersForTest();
    expect(await resolveErpClient({ rpc: rpc(null), encryptionKey: KEY }, "org")).toMatchObject({ status: "not_connected" });
    expect(await resolveErpClient({ rpc: rpc(row()), encryptionKey: KEY }, "org")).toMatchObject({ status: "not_configured" });
    const createClient = vi.fn((credentials: unknown) => {
      if (!(credentials as { refresh_token?: string }).refresh_token) throw new Error("bad");
      return createFakeErpClient({ snapshot: snapshot() }).client;
    });
    registerErpProvider({ provider: "quickbooks", label: "QuickBooks Online", createClient });
    expect(await resolveErpClient({ rpc: rpc(row()), encryptionKey: null }, "org")).toMatchObject({ status: "not_configured" });
    expect(await resolveErpClient({ rpc: rpc(row({ encrypted_b64: null })), encryptionKey: KEY }, "org")).toMatchObject({
      status: "credential_unavailable",
    });
    const otherKey = `v1:${randomBytes(32).toString("base64")}`;
    expect(await resolveErpClient({ rpc: rpc(row()), encryptionKey: otherKey }, "org")).toMatchObject({ status: "credential_unavailable" });
    expect(
      await resolveErpClient({ rpc: rpc(row({ encrypted_b64: encryptCredential("{}", KEY) })), encryptionKey: KEY }, "org"),
    ).toMatchObject({ status: "credential_unavailable" });
    const ready = await resolveErpClient({ rpc: rpc(row()), encryptionKey: KEY }, "org");
    expect(ready.status).toBe("ready");
    expect(createClient).toHaveBeenLastCalledWith({ refresh_token: "r" }, expect.anything());
    resetErpProvidersForTest();
  });
});

describe("snapshot normalization", () => {
  it("orders rows deterministically and ignores as_of in the content hash", () => {
    const a = snapshot();
    a.stock.push({ item_external_id: "item-1", location_external_id: "wh-1", on_hand_qty: 10 });
    a.suppliers.push({ external_id: "sup-0", name: "Alpha" });
    const n = normalizeSnapshot(a);
    expect(n.suppliers.map((s) => s.external_id)).toEqual(["sup-0", "sup-1"]);
    expect(n.stock).toEqual([{ item_external_id: "item-1", location_external_id: "wh-1", on_hand_qty: 610, unusable_qty: 0 }]);
    const later = normalizeSnapshot({ ...a, as_of: "2030-02-01T00:00:00.000Z", suppliers: [...a.suppliers].reverse() });
    expect(snapshotContentHash(later)).toBe(snapshotContentHash(n));
    const changed = snapshot();
    changed.purchase_orders[0].version = "v1";
    expect(snapshotContentHash(normalizeSnapshot(changed))).not.toBe(snapshotContentHash(n));
  });

  it("rejects fractional quantities at the provider boundary", () => {
    const bad = snapshot();
    bad.purchase_orders[0].lines[0].ordered_qty = 10.5;
    expect(() => normalizeSnapshot(bad)).toThrow();
  });
});

describe("Business system availability", () => {
  const key = { CREDENTIAL_ENCRYPTION_KEY: KEY };
  it("hides everything without an encryption key and gates OAuth providers on their client id", () => {
    expect(availableBusinessSystems({ QBO_CLIENT_ID: "x", ZOHO_CLIENT_ID: "x", SHOPIFY_CLIENT_ID: "x" })).toEqual([]);
    expect(availableBusinessSystems(key).map((o) => o.provider)).toEqual(["odoo"]);
    expect(availableBusinessSystems({ ...key, QUICKBOOKS_CLIENT_ID: "x" }).map((o) => o.provider)).toEqual(["odoo"]);
    expect(
      availableBusinessSystems({ ...key, QBO_CLIENT_ID: "x", ZOHO_CLIENT_ID: "x", SHOPIFY_CLIENT_ID: "x" }).map((o) => o.provider),
    ).toEqual(["odoo", "zoho_inventory", "quickbooks", "shopify"]);
  });
});
