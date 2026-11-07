import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { registerAdapter } from "@/lib/actions/adapters";
import { reconcileAction } from "@/lib/actions/dispatcher";
import { registerLiveStepPreparer } from "@/lib/actions/live-step";
import { executeApprovedPlan, exportPlan } from "@/lib/actions/plans";
import { createLiveBusinessAdapter } from "@/lib/integrations/business/live/adapter";
import { storeErpConnection } from "@/lib/integrations/business/live/connections";
import { createFakeErpClient } from "@/lib/integrations/business/live/fake";
import { prepareLiveStepPayload } from "@/lib/integrations/business/live/prepare";
import { registerErpProvider, resetErpProvidersForTest } from "@/lib/integrations/business/live/registry";
import { resolveErpClient } from "@/lib/integrations/business/live/resolve";
import { runConnectionSync } from "@/lib/integrations/business/live/run-sync";
import type { ErpClient, ErpSnapshot } from "@/lib/integrations/business/live/types";
import { approve, connect, createPlan, deps, FakeClock, seedHarbor, splitStep, type Harbor } from "./actions.harness";

vi.mock("server-only", () => ({}));

// Fake in-memory ErpClient against the local database; no provider is contacted.
const client = connect();
const KEY = `v1:${randomBytes(32).toString("base64")}`;
beforeAll(() => client.connect());
afterAll(() => {
  resetErpProvidersForTest();
  registerLiveStepPreparer(null);
  return client.end();
});

const snapshot = (poId: string): ErpSnapshot => ({
  as_of: "2026-10-12T14:00:00.000Z",
  locations: [{ external_id: "wh-1", name: "Main DC" }],
  items: [{ external_id: "item-1", sku: "CTN-12", name: "12in carton", unit: "carton" }],
  suppliers: [{ external_id: "sup-1", name: "Acme Corrugated" }],
  purchase_orders: [
    {
      external_id: poId,
      supplier_external_id: "sup-1",
      currency: "USD",
      status: "open",
      version: "v0",
      lines: [
        {
          external_line_id: `${poId}-1`,
          item_external_id: "item-1",
          ordered_qty: 4000,
          received_qty: 0,
          unit_price_minor: "100",
          due_at: "2026-10-16T15:00:00.000Z",
          destination_external_id: "wh-1",
        },
      ],
    },
  ],
  stock: [{ item_external_id: "item-1", location_external_id: "wh-1", on_hand_qty: 600 }],
  demand: [],
});

let active: ErpClient | null = null;
registerErpProvider({ provider: "odoo", label: "Odoo", createClient: () => active! });

async function setup(override?: Partial<ErpClient>) {
  const clock = new FakeClock();
  const d = deps(client, clock);
  const h = await seedHarbor(client, { mode: "sandbox" });
  const poId = `PO-${h.orgId.slice(0, 8)}`;
  const fake = createFakeErpClient({ snapshot: snapshot(poId) });
  active = { ...fake.client, ...override };
  const resolve = (orgId: string, connectionId?: string) =>
    resolveErpClient({ rpc: d.rpc, encryptionKey: KEY }, orgId, connectionId);
  registerAdapter(createLiveBusinessAdapter({ resolve: (action, connectionId) => resolve(action.orgId, connectionId) }));
  registerLiveStepPreparer((input) => prepareLiveStepPayload({ ...d, resolve: (orgId) => resolve(orgId) }, input));
  const { connectionId } = await storeErpConnection(
    {
      orgId: h.orgId,
      actorUserId: h.ownerId,
      provider: "odoo",
      externalAccountId: "test-db",
      scopes: [],
      credentials: { api_key: "test" },
      expiresAt: null,
    },
    { rpc: d.rpc, encryptionKey: KEY, requestSync: async () => {} },
  );
  const sync = () => runConnectionSync({ rpc: d.rpc, clock, encryptionKey: KEY }, { orgId: h.orgId, connectionId });
  return { clock, d, h, poId, fake, connectionId, sync };
}

async function liveStep(h: Harbor, poId: string) {
  const line = (
    await client.query(
      `select l.id, s.id schedule_id from purchase_order_lines l
       join purchase_orders po on po.id = l.purchase_order_id
       join receipt_schedules s on s.po_line_id = l.id and s.promise_state <> 'superseded'
       where po.org_id = $1 and po.external_id = $2`,
      [h.orgId, poId],
    )
  ).rows[0];
  const step = splitStep(h);
  return {
    ...step,
    execution_mode: "live_connector",
    payload: { ...step.payload, po_line_id: line.id, receipt_schedule_id: line.schedule_id, demand_ids: [] },
  };
}

describe("live business connector (fake ErpClient, local database)", () => {
  it("imports a snapshot with provider versions, no-ops on unchanged content, and ingests receipts once", async () => {
    const { h, poId, fake, sync } = await setup();
    const first = await sync();
    expect(first).toMatchObject({ status: "synced", snapshot: { outcome: "activated" } });
    const po = (await client.query("select * from purchase_orders where org_id = $1 and external_id = $2", [h.orgId, poId])).rows[0];
    expect(po.source_version).toBe("v0");
    const dataset = (await client.query("select * from datasets where org_id = $1 and status = 'active'", [h.orgId])).rows;
    expect(dataset).toHaveLength(1);
    expect(dataset[0].source_type).toBe("connector");
    expect((await client.query("select status from datasets where id = $1", [h.datasetId])).rows[0].status).toBe("superseded");

    expect(await sync()).toMatchObject({ status: "synced", snapshot: { outcome: "noop_same_content" } });

    fake.receive(poId, `${poId}-1`, 100);
    const third = await sync();
    expect(third).toMatchObject({ status: "synced", snapshot: { outcome: "activated" }, receipts: { recorded: 1 } });
    const again = await sync();
    expect(again).toMatchObject({ receipts: { recorded: 0, duplicates: 1 } });
    const receipts = await client.query("select external_receipt_id from receiving_events where org_id = $1", [h.orgId]);
    expect(receipts.rows.map((r) => r.external_receipt_id)).toEqual(["odoo:rcpt-1"]);
    const conn = (await client.query("select status, last_error_code from connections where org_id = $1 and provider = 'odoo'", [h.orgId])).rows[0];
    expect(conn).toEqual({ status: "healthy", last_error_code: null });
  });

  it("writes an approved delivery split, reads it back, and confirms", async () => {
    const { d, h, poId, fake, sync } = await setup();
    await sync();
    const plan = await createPlan(d, h, [await liveStep(h, poId)]);
    expect(plan).toMatchObject({ ok: true, status: "ready" });
    const approval = await approve(d, client, h, plan.plan_id);
    const run = await executeApprovedPlan(d, { orgId: h.orgId, planId: plan.plan_id, approvalId: approval.approval_id });
    expect(run.status).toBe("dispatch");
    const action = (await client.query("select * from actions where plan_id = $1", [plan.plan_id])).rows[0];
    expect(action).toMatchObject({ kind: "live_business_amendment", state: "confirmed", provider: "odoo" });
    expect(action.payload.erp).toMatchObject({ provider: "odoo", po_external_id: poId, expected_version: "v0" });
    expect(await fake.client.findChange(action.id, poId)).toMatchObject({ status: "applied" });
  });

  it("does not write when the PO changed after approval", async () => {
    const { d, h, poId, fake, sync } = await setup();
    await sync();
    const plan = await createPlan(d, h, [await liveStep(h, poId)]);
    const approval = await approve(d, client, h, plan.plan_id);
    fake.touch(poId);
    const run = await executeApprovedPlan(d, { orgId: h.orgId, planId: plan.plan_id, approvalId: approval.approval_id });
    expect(run.status).toBe("prepare_failed");
    const actions = await client.query("select id from actions where plan_id = $1 and state = 'confirmed'", [plan.plan_id]);
    expect(actions.rowCount).toBe(0);
    expect((await fake.client.readPurchaseOrder(poId))!.lines).toHaveLength(1);
  });

  it("hands off to manual execution when the provider cannot change purchase orders", async () => {
    const { d, h, poId, sync } = await setup({
      applyDeliverySplit: async () => ({ status: "rejected", code: "not_supported_by_provider", message: "Read-only" }),
    });
    await sync();
    const plan = await createPlan(d, h, [await liveStep(h, poId)]);
    const approval = await approve(d, client, h, plan.plan_id);
    await executeApprovedPlan(d, { orgId: h.orgId, planId: plan.plan_id, approvalId: approval.approval_id });
    const action = (await client.query("select * from actions where plan_id = $1", [plan.plan_id])).rows[0];
    expect(action).toMatchObject({ state: "submitted", error_code: "not_supported_by_provider" });
    expect(await reconcileAction(d, h.orgId, action.id)).toMatchObject({ status: "awaiting_manual_confirmation" });
    const exported = await exportPlan(d, { orgId: h.orgId, planId: plan.plan_id, userId: h.ownerId, idempotencyKey: "export-1" });
    expect(exported).toMatchObject({ ok: true, action: { id: action.id } });
  });

  it("reports not connected and never prepares a live action without a connection", async () => {
    const clock = new FakeClock();
    const d = deps(client, clock);
    const h = await seedHarbor(client, { mode: "sandbox" });
    expect(await resolveErpClient({ rpc: d.rpc, encryptionKey: KEY }, h.orgId)).toMatchObject({ status: "not_connected" });
    const step = { ...splitStep(h), execution_mode: "live_connector" };
    const plan = await createPlan(d, h, [step]);
    expect(plan.missing_fields ?? []).toBeDefined();
    expect((await client.query("select missing_fields from plan_steps where plan_id = $1", [plan.plan_id])).rows[0].missing_fields).toContain(
      "live_connector_unavailable",
    );
  });
});
