import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { registerAdapter } from "@/lib/actions/adapters";
import { reconcileAction } from "@/lib/actions/dispatcher";
import { registerLiveStepPreparer, registerTransferGate } from "@/lib/actions/live-step";
import { createPlan as createPlanApi, executeApprovedPlan, exportPlan } from "@/lib/actions/plans";
import { storeErpConnection } from "@/lib/integrations/business/live/connections";
import { prepareLiveStepPayload } from "@/lib/integrations/business/live/prepare";
import { prepareLiveTransferPayload } from "@/lib/integrations/business/live/prepare-transfer";
import { ensureErpProviders } from "@/lib/integrations/business/live/providers";
import { registerErpProvider, resetErpProvidersForTest } from "@/lib/integrations/business/live/registry";
import { resolveErpClient } from "@/lib/integrations/business/live/resolve";
import { runConnectionSync } from "@/lib/integrations/business/live/run-sync";
import { shopifyProvider } from "@/lib/integrations/business/live/shopify";
import { evaluateTransferGate } from "@/lib/integrations/business/live/transfer-gate";
import { createLiveTransferAdapter } from "@/lib/integrations/business/live/transfer-adapter";
import type { ErpClient, ErpSnapshot } from "@/lib/integrations/business/live/types";
import { createShopifyEmulator } from "../fixtures/shopify-emulator";
import { approve, connect, deps, FakeClock, seedHarbor, splitStep, createPlan as rawPlan } from "./actions.harness";

vi.mock("server-only", () => ({}));

// Shopify is emulated (no network): the real connector code runs against documented response shapes.
// The database is the local Supabase one, so the ledger, approval and claim rules are the real ones.
const client = connect();
const KEY = `v1:${randomBytes(32).toString("base64")}`;
const ITEM_EXT = "gid://shopify/InventoryItem/11";
const DEST_EXT = "gid://shopify/Location/1";
const SOURCE_EXT = "gid://shopify/Location/3";
const WRITE_SCOPE = "read_inventory,write_inventory_transfers,write_inventory_shipments";

beforeAll(() => client.connect());
afterEach(() => {
  registerTransferGate(null);
});
afterAll(() => {
  resetErpProvidersForTest();
  registerLiveStepPreparer(null);
  return client.end();
});

ensureErpProviders();
let active: ErpClient | null = null;
registerErpProvider({ provider: "shopify", label: "Shopify", createClient: () => active! });

function snapshotFor(shopify: ReturnType<typeof createShopifyEmulator>, destDemand = 300): ErpSnapshot {
  return {
    as_of: "2026-10-12T14:00:00.000Z",
    locations: [
      { external_id: DEST_EXT, name: "Main DC" },
      { external_id: SOURCE_EXT, name: "Overflow DC" },
    ],
    items: [{ external_id: ITEM_EXT, sku: "CTN-12", name: "12in carton", unit: "carton" }],
    suppliers: [],
    purchase_orders: [],
    stock: [
      { item_external_id: ITEM_EXT, location_external_id: DEST_EXT, on_hand_qty: 100 },
      { item_external_id: ITEM_EXT, location_external_id: SOURCE_EXT, on_hand_qty: shopify.level(ITEM_EXT, SOURCE_EXT)!.on_hand },
    ],
    demand: [
      { external_id: "dest-1", item_external_id: ITEM_EXT, location_external_id: DEST_EXT, quantity: destDemand, required_at: "2026-10-14T16:00:00.000Z", certainty: "confirmed" },
      { external_id: "src-1", item_external_id: ITEM_EXT, location_external_id: SOURCE_EXT, quantity: 450, required_at: "2026-10-15T16:00:00.000Z", certainty: "confirmed" },
    ],
  };
}

async function setup(options: { scope?: string } = {}) {
  const clock = new FakeClock();
  const d = deps(client, clock);
  const h = await seedHarbor(client, { mode: "sandbox" });
  const shopify = createShopifyEmulator({ now: () => clock.now() });
  shopify.setLevel(ITEM_EXT, SOURCE_EXT, { on_hand: 500 });
  const real = shopifyProvider.createClient(
    { shop: "conduit-dev.myshopify.com", access_token: "t", scope: options.scope ?? WRITE_SCOPE, access_token_expires_at: null, refresh_token: null, refresh_token_expires_at: null },
    { fetch: shopify.fetch },
  );
  let destDemand = 300;
  active = { ...real, readSnapshot: async () => snapshotFor(shopify, destDemand) };
  const resolve = (orgId: string, connectionId?: string) => resolveErpClient({ rpc: d.rpc, encryptionKey: KEY }, orgId, connectionId);
  registerAdapter(createLiveTransferAdapter({ resolve: (action, connectionId) => resolve(action.orgId, connectionId) }));
  registerLiveStepPreparer(async (input) => {
    const prep = { ...d, resolve: (orgId: string) => resolve(orgId) };
    if (input.step?.kind === "transfer_stock") {
      const prepared = await prepareLiveTransferPayload(prep, { ...input, step: input.step });
      return prepared.ok ? { ok: true, payload: prepared.payload, kind: "live_business_transfer" } : prepared;
    }
    return prepareLiveStepPayload(prep, input);
  });
  registerTransferGate((orgId) => evaluateTransferGate((id) => resolve(id), orgId));
  const { connectionId } = await storeErpConnection(
    { orgId: h.orgId, actorUserId: h.ownerId, provider: "shopify", externalAccountId: "conduit-dev.myshopify.com", scopes: [], credentials: { access_token: "t" }, expiresAt: null },
    { rpc: d.rpc, encryptionKey: KEY, requestSync: async () => {} },
  );
  const sync = () => runConnectionSync({ rpc: d.rpc, clock, encryptionKey: KEY }, { orgId: h.orgId, connectionId });
  await sync();
  const sourceLocationId = (await client.query("select id from locations where org_id = $1 and external_id = $2", [h.orgId, SOURCE_EXT])).rows[0].id as string;
  return { clock, d, h, shopify, sync, sourceLocationId, setDestDemand: (n: number) => { destDemand = n; } };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function transferStep(s: Setup, overrides: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) {
  return {
    step_id: "transfer-1",
    kind: "transfer_stock" as const,
    item_id: s.h.itemId,
    unit: "carton",
    quantity: 50,
    destination_location_id: s.h.locationId,
    depends_on_step_ids: [],
    evidence_ids: [],
    execution_mode: "live_connector" as const,
    payload: {
      source_location_id: s.sourceLocationId,
      arrival_end: "2026-10-13T12:00:00.000Z",
      transfer_cost_minor: "2500",
      summary: "Move 50 carton from Overflow DC to Main DC",
      ...payload,
    },
    ...overrides,
  };
}

const create = (s: Setup, step: ReturnType<typeof transferStep>, key = `plan-${Math.random()}`) =>
  createPlanApi(s.d, { orgId: s.h.orgId, caseId: s.h.caseId, userId: s.h.operatorId, idempotencyKey: key, body: { assessment_id: s.h.assessmentId, steps: [step] } as never });

async function readyPlan(s: Setup, step = transferStep(s)) {
  const plan = await create(s, step);
  if (!plan.ok) throw new Error(`plan refused: ${JSON.stringify(plan)}`);
  expect(plan.status).toBe("ready");
  const approval = await approve(s.d, client, s.h, plan.plan_id, { ceiling: "2500" });
  expect(approval.ok).toBe(true);
  return { plan, approval };
}

const actionsFor = async (planId: string) => (await client.query("select * from actions where plan_id = $1 order by created_at", [planId])).rows;
const claimsFor = async (planId: string) =>
  (await client.query("select location_id, quantity, state from allocation_claims where plan_id = $1 order by location_id", [planId])).rows;

describe("live stock transfer (Shopify emulator, local database)", () => {
  it("creates the action before dispatch, executes once approved, and confirms from a readback", async () => {
    const s = await setup();
    const { plan, approval } = await readyPlan(s);
    expect(plan).toMatchObject({ gross_commitment_minor: "2500" });
    expect(await actionsFor(plan.plan_id)).toHaveLength(0);

    const run = await executeApprovedPlan(s.d, { orgId: s.h.orgId, planId: plan.plan_id, approvalId: approval.approval_id });
    expect(run.status).toBe("dispatch");

    const [action] = await actionsFor(plan.plan_id);
    expect(action).toMatchObject({ kind: "live_business_transfer", state: "confirmed", provider: "shopify", attempts: 1, approval_id: approval.approval_id });
    expect(action.provider_ref).toMatch(/^gid:\/\/shopify\/InventoryTransfer\/\d+#CDT-/);
    expect(action.outcome.safe_summary).toContain("50 units dispatched and in transit");
    expect(action.payload.erp).toMatchObject({
      provider: "shopify",
      source_location_external_id: SOURCE_EXT,
      destination_location_external_id: DEST_EXT,
      min_source_on_hand_after: 450,
    });
    expect(new Date(action.created_at).getTime()).toBeLessThanOrEqual(new Date(action.dispatch_started_at).getTime());

    expect(s.shopify.transfers).toHaveLength(1);
    expect(s.shopify.level(ITEM_EXT, SOURCE_EXT)?.on_hand).toBe(450);
    expect((await client.query("select status, consumed_by_action_id from approvals where id = $1", [approval.approval_id])).rows[0]).toEqual({
      status: "consumed",
      consumed_by_action_id: action.id,
    });
    expect((await client.query("select status from recovery_plans where id = $1", [plan.plan_id])).rows[0].status).toBe("executed");
    expect((await client.query("select phase from cases where id = $1", [s.h.caseId])).rows[0].phase).toBe("monitoring");
    // The same quantity was held at both ends while it was in flight, then consumed.
    expect(await claimsFor(plan.plan_id)).toEqual(
      expect.arrayContaining([
        { location_id: s.h.locationId, quantity: 50, state: "consumed" },
        { location_id: s.sourceLocationId, quantity: 50, state: "consumed" },
      ]),
    );
  });

  it("is idempotent: replaying the approval event neither re-sends nor creates a second action", async () => {
    const s = await setup();
    const { plan, approval } = await readyPlan(s);
    const input = { orgId: s.h.orgId, planId: plan.plan_id, approvalId: approval.approval_id };
    await executeApprovedPlan(s.d, input);
    const replay = await executeApprovedPlan(s.d, input);

    expect(replay).toMatchObject({ status: "dispatch", report: { status: "terminal" } });
    expect(await actionsFor(plan.plan_id)).toHaveLength(1);
    expect(s.shopify.transfers).toHaveLength(1);
    expect(s.shopify.requests.filter((r) => r.operationName === "ConduitTransferCreate")).toHaveLength(1);
  });

  it("refuses at plan creation a quantity the source cannot spare, and stores no plan", async () => {
    const s = await setup();
    const before = (await client.query("select count(*)::int n from recovery_plans where case_id = $1", [s.h.caseId])).rows[0].n;
    const result = await create(s, transferStep(s, { quantity: 51 }));

    expect(result).toMatchObject({ ok: false, code: "validation_failed", reason: "source_coverage_insufficient", max_safe_quantity: 50 });
    expect((await client.query("select count(*)::int n from recovery_plans where case_id = $1", [s.h.caseId])).rows[0].n).toBe(before);
  });

  it("keeps a transfer with unknown timing out of the ready state", async () => {
    const s = await setup();
    const raw = await rawPlan(s.d, s.h, [{ ...transferStep(s), payload: { source_location_id: s.sourceLocationId, transfer_cost_minor: "2500" } }]);
    expect(raw).toMatchObject({ ok: true, status: "draft" });
    expect((await client.query("select missing_fields from plan_steps where plan_id = $1", [raw.plan_id])).rows[0].missing_fields).toContain("arrival_window");
  });

  it("does not execute when the source's stock drops after approval, and writes nothing", async () => {
    const s = await setup();
    const { plan, approval } = await readyPlan(s);
    s.shopify.setLevel(ITEM_EXT, SOURCE_EXT, { on_hand: 470 });

    const run = await executeApprovedPlan(s.d, { orgId: s.h.orgId, planId: plan.plan_id, approvalId: approval.approval_id });
    expect(run).toMatchObject({ status: "prepare_failed", failure: { reason: "source_coverage_insufficient" } });
    expect(await actionsFor(plan.plan_id)).toHaveLength(0);
    expect(s.shopify.transfers).toHaveLength(0);
  });

  it("revokes the approval and writes nothing when business data changes after approval", async () => {
    const s = await setup();
    const { plan, approval } = await readyPlan(s);
    s.setDestDemand(250);

    const run = await executeApprovedPlan(s.d, { orgId: s.h.orgId, planId: plan.plan_id, approvalId: approval.approval_id });
    expect(run).toMatchObject({ status: "prepare_failed", failure: { code: "stale_fingerprint" } });
    expect((await client.query("select status from approvals where id = $1", [approval.approval_id])).rows[0].status).toBe("revoked");
    expect((await client.query("select status from recovery_plans where id = $1", [plan.plan_id])).rows[0].status).toBe("expired");
    expect(s.shopify.transfers).toHaveLength(0);
  });

  it("will not prepare an action whose terms differ from the approved step", async () => {
    const s = await setup();
    const { plan, approval } = await readyPlan(s);
    const prepared = await prepareLiveTransferPayload(
      { ...s.d, resolve: (orgId) => resolveErpClient({ rpc: s.d.rpc, encryptionKey: KEY }, orgId) },
      { orgId: s.h.orgId, stepPayload: transferStep(s).payload, step: { kind: "transfer_stock", quantity: 50, item_id: s.h.itemId, destination_location_id: s.h.locationId } },
    );
    if (!prepared.ok) throw new Error("prepare failed");
    for (const tamper of [{ quantity: 40 }, { arrival_end: "2026-10-20T12:00:00.000Z" }, { transfer_cost_minor: "0" }]) {
      const result = (await s.d.rpc("ledger_prepare_action", {
        p_org_id: s.h.orgId,
        p_actor_type: "system",
        p_actor_id: "execution",
        p_case_id: s.h.caseId,
        p_kind: "live_business_transfer",
        p_payload: { ...prepared.payload, ...tamper },
        p_idempotency_key: `tamper-${JSON.stringify(tamper)}`,
        p_contact_id: null,
        p_plan_id: plan.plan_id,
        p_plan_step_id: "transfer-1",
        p_approval_id: approval.approval_id,
        p_now: s.d.clock.now().toISOString(),
      })) as { ok: boolean; code?: string };
      expect(result).toMatchObject({ ok: false, code: "validation_failed" });
    }
    expect(await actionsFor(plan.plan_id)).toHaveLength(0);
    expect((await client.query("select status from approvals where id = $1", [approval.approval_id])).rows[0].status).toBe("active");
  });

  it("blocks the case on an unknown outcome and reconciles by reading Shopify, not by writing again", async () => {
    const s = await setup();
    const { plan, approval } = await readyPlan(s);
    s.shopify.failNext("ConduitShipmentCreateInTransit", "drop_response");

    const run = await executeApprovedPlan(s.d, { orgId: s.h.orgId, planId: plan.plan_id, approvalId: approval.approval_id });
    expect(run).toMatchObject({ status: "dispatch", report: { action: { state: "unknown" } } });
    const [unknown] = await actionsFor(plan.plan_id);
    expect(unknown.state).toBe("unknown");
    expect((await client.query("select run_control, block_reason from cases where id = $1", [s.h.caseId])).rows[0]).toEqual({
      run_control: "blocked",
      block_reason: "outcome_unknown",
    });
    expect((await client.query("select status from recovery_plans where id = $1", [plan.plan_id])).rows[0].status).toBe("execution_uncertain");
    expect((await claimsFor(plan.plan_id)).every((c) => c.state === "uncertain")).toBe(true);

    const writes = () => s.shopify.requests.filter((r) => r.operationName === "ConduitTransferCreate" || r.operationName === "ConduitShipmentCreateInTransit").length;
    const writesBefore = writes();
    const report = await reconcileAction(s.d, s.h.orgId, unknown.id);
    expect(report).toMatchObject({ status: "reconciled", action: { state: "confirmed" } });
    expect(writes()).toBe(writesBefore);
    expect(s.shopify.transfers).toHaveLength(1);

    expect((await client.query("select status from recovery_plans where id = $1", [plan.plan_id])).rows[0].status).toBe("executed");
    expect((await client.query("select run_control, phase from cases where id = $1", [s.h.caseId])).rows[0]).toEqual({ run_control: "active", phase: "monitoring" });
    expect((await claimsFor(plan.plan_id)).every((c) => c.state === "consumed")).toBe(true);
  });

  it("stays unknown while stock is reserved but not dispatched, and fails if the transfer is cancelled", async () => {
    const s = await setup();
    const { plan, approval } = await readyPlan(s);
    s.shopify.failNext("ConduitShipmentCreateInTransit", { code: "INVALID", message: "rejected" });
    await executeApprovedPlan(s.d, { orgId: s.h.orgId, planId: plan.plan_id, approvalId: approval.approval_id });
    const [action] = await actionsFor(plan.plan_id);
    expect(action.state).toBe("unknown");

    expect(await reconcileAction(s.d, s.h.orgId, action.id)).toMatchObject({ action: { state: "unknown" } });
    s.shopify.transfers[0].status = "CANCELED";
    expect(await reconcileAction(s.d, s.h.orgId, action.id)).toMatchObject({ action: { state: "failed", error_code: "transfer_cancelled" } });
    expect((await claimsFor(plan.plan_id)).every((c) => c.state === "released")).toBe(true);
    expect((await client.query("select status from recovery_plans where id = $1", [plan.plan_id])).rows[0].status).toBe("failed");
  });

  it("allows only one automated write per plan", async () => {
    const s = await setup();
    const result = await rawPlan(s.d, s.h, [transferStep(s), { ...splitStep(s.h), execution_mode: "live_connector" }]);
    expect(result).toMatchObject({ ok: false, code: "multi_write_not_supported" });
  });
});

describe("recommend-only transfer (connection without transfer permission)", () => {
  it("refuses a live transfer step but accepts a manual one, which exports as a handoff and executes nothing", async () => {
    const s = await setup({ scope: "read_inventory" });
    const live = await create(s, transferStep(s));
    expect(live).toMatchObject({ ok: false, code: "unsupported_step", reason: "transfer_permission_missing" });

    const manual = transferStep(s, { execution_mode: "manual" });
    const plan = await create(s, manual);
    if (!plan.ok) throw new Error("manual plan refused");
    expect(plan.status).toBe("ready");
    const approval = await approve(s.d, client, s.h, plan.plan_id, { ceiling: "2500" });
    expect(await executeApprovedPlan(s.d, { orgId: s.h.orgId, planId: plan.plan_id, approvalId: approval.approval_id })).toEqual({ status: "no_automated_step" });

    const exported = await exportPlan(s.d, { orgId: s.h.orgId, planId: plan.plan_id, userId: s.h.ownerId, idempotencyKey: "export-transfer" });
    if (!exported.ok) throw new Error("export failed");
    expect(exported.packet.json.steps).toEqual([expect.objectContaining({ kind: "transfer_stock", quantity: 50, payload: expect.objectContaining({ source_location_id: s.sourceLocationId }) })]);
    expect(s.shopify.transfers).toHaveLength(0);
  });
});

describe("transfer options inputs", () => {
  it("serves the source's projection facts to the same deterministic check the plan uses", async () => {
    const s = await setup();
    const facts = await s.d.rpc("load_projection_facts", { p_org_id: s.h.orgId, p_item_id: s.h.itemId, p_location_id: s.sourceLocationId });
    const { sourceSpareQuantity } = await import("@/lib/domain/transfers");
    expect(sourceSpareQuantity(facts as never)).toEqual({ ok: true, physicalQty: 500, maxSafeQuantity: 50 });
  });
});
