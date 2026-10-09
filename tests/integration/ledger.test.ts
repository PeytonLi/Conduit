import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatchAction } from "@/lib/actions/dispatcher";
import { executeApprovedPlan, exportPlan } from "@/lib/actions/plans";
import { deliveryStatus, markDelivered, recordReceipt } from "@/lib/actions/receipts";
import { approve, connect, createPlan, deps, FakeClock, seedHarbor, splitStep } from "./actions.harness";

const client = connect();
beforeAll(() => client.connect());
afterAll(() => client.end());

const schedules = async (poLineId: string) =>
  (await client.query(
    "select quantity_remaining q, earliest_at, promise_state from public.receipt_schedules where po_line_id = $1 and promise_state <> 'superseded' order by earliest_at",
    [poLineId],
  )).rows;

describe("demo ledger, manual export and delivery lifecycle", () => {
  it("AT-23: approved split is written once to the labeled demo ledger, confirmed by readback, then monitored", async () => {
    const clock = new FakeClock();
    const d = deps(client, clock);
    const h = await seedHarbor(client);
    const plan = await createPlan(d, h);
    const approval = await approve(d, client, h, plan.plan_id);
    const first = await executeApprovedPlan(d, { orgId: h.orgId, planId: plan.plan_id, approvalId: approval.approval_id });
    expect(first).toMatchObject({ status: "dispatch", report: { status: "dispatched", action: { state: "confirmed" } } });
    const retry = await executeApprovedPlan(d, { orgId: h.orgId, planId: plan.plan_id, approvalId: approval.approval_id });
    expect(retry).toMatchObject({ status: "dispatch", report: { status: "terminal" } });

    const entries = await client.query("select label from public.demo_ledger_entries where org_id = $1", [h.orgId]);
    expect(entries.rows).toHaveLength(1);
    expect(entries.rows[0].label).toMatch(/^DEMO LEDGER/);
    expect((await schedules(h.poLineId)).map((r) => r.q)).toEqual([600, 3400]);
    const caseRow = (await client.query("select phase from public.cases where id = $1", [h.caseId])).rows[0];
    expect(caseRow.phase).toBe("monitoring");
    const audit = await client.query("select event_name from public.audit_events where case_id = $1 order by occurred_at, event_name", [h.caseId]);
    expect(audit.rows.map((r) => r.event_name)).toEqual(expect.arrayContaining(["plan.approved", "action.prepared", "action.dispatching", "action.confirmed"]));
    const claims = await client.query("select state from public.allocation_claims where plan_id = $1", [plan.plan_id]);
    expect(claims.rows.map((r) => r.state)).toEqual(["consumed"]);
  });

  it("AT-24: CSV-sourced plans export a complete manual packet with status manual_handoff, never applied", async () => {
    const clock = new FakeClock();
    const d = deps(client, clock);
    const h = await seedHarbor(client);
    const plan = await createPlan(d, h, [splitStep(h, "manual")]);
    await approve(d, client, h, plan.plan_id);
    const key = randomUUID();
    const exported = await exportPlan(d, { orgId: h.orgId, planId: plan.plan_id, userId: h.operatorId, idempotencyKey: key });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.packet.status).toBe("manual_handoff");
    expect(exported.action).toMatchObject({ kind: "manual_export", state: "submitted" });
    expect(exported.action.provider_ref).toMatch(/^manual_handoff:/);
    expect(exported.packet.csv).toContain("amend_delivery_schedule");
    const again = await exportPlan(d, { orgId: h.orgId, planId: plan.plan_id, userId: h.operatorId, idempotencyKey: key });
    expect(again).toMatchObject({ ok: true, replayed: true });
    expect((await client.query("select count(*)::int n from public.actions where plan_id = $1", [plan.plan_id])).rows[0].n).toBe(1);
    expect((await schedules(h.poLineId)).map((r) => r.q)).toEqual([4000]);
    const caseRow = (await client.query("select run_control, block_reason from public.cases where id = $1", [h.caseId])).rows[0];
    expect(caseRow).toEqual({ run_control: "blocked", block_reason: "manual_execution_required" });
    const confirm = await d.rpc("ledger_record_outcome", {
      p_org_id: h.orgId, p_action_id: exported.action.id, p_outcome: "confirmed", p_provider_ref: null, p_safe_summary: "x",
      p_error_code: null, p_source: "reconcile", p_actor_id: "system", p_evidence_id: null, p_now: clock.now().toISOString(),
    });
    expect(confirm).toMatchObject({ ok: false, code: "evidence_required" });
    expect(await dispatchAction(d, h.orgId, exported.action.id)).toMatchObject({ status: "awaiting_manual_confirmation" });
  });

  it("AT-26: partial receipt, revised ETA, full receipt; delivered only with receiving evidence", async () => {
    const clock = new FakeClock();
    const d = deps(client, clock);
    const h = await seedHarbor(client);
    const plan = await createPlan(d, h);
    const approval = await approve(d, client, h, plan.plan_id);
    await executeApprovedPlan(d, { orgId: h.orgId, planId: plan.plan_id, approvalId: approval.approval_id });
    expect(await markDelivered(d, h.orgId, h.caseId, "test")).toMatchObject({ ok: false, code: "receiving_evidence_missing" });

    const r = (id: string, quantity: number, extra = {}) =>
      recordReceipt(d, { orgId: h.orgId, actorId: "test", receipt: { po_line_id: h.poLineId, external_receipt_id: id, quantity, received_at: clock.now().toISOString(), ...extra } });
    expect(await r("RCV-1", 600)).toMatchObject({ ok: true, duplicate: false });
    expect(await r("RCV-1", 600)).toMatchObject({ ok: true, duplicate: true });
    expect(await r("RCV-1", 500)).toMatchObject({ ok: false, code: "idempotency_conflict" });
    expect((await schedules(h.poLineId)).map((s) => s.q)).toEqual([0, 3400]);
    expect((await deliveryStatus(d, h.orgId, h.caseId)) as unknown).toMatchObject({ delivered: false });

    // Revised ETA for the remainder, then a reversal reopens recovery.
    await client.query("update public.receipt_schedules set earliest_at = '2026-10-19T15:00:00Z', latest_at = '2026-10-19T22:00:00Z' where po_line_id = $1 and quantity_remaining = 3400", [h.poLineId]);
    const reversal = await r("RCV-1-REV", 100, { kind: "reversal", reverses_external_id: "RCV-1" });
    expect(reversal).toMatchObject({ ok: true, reopened_case_ids: [h.caseId] });
    await client.query("update public.cases set phase = 'monitoring' where id = $1", [h.caseId]);
    expect(await r("RCV-2", 3500)).toMatchObject({ ok: true });
    expect(await r("RCV-3", 1)).toMatchObject({ ok: false, code: "over_receipt" });
    expect((await deliveryStatus(d, h.orgId, h.caseId)) as unknown).toMatchObject({ delivered: true });
    expect(await markDelivered(d, h.orgId, h.caseId, "test")).toMatchObject({ ok: true, closed_outcome: "delivered" });
  });
});
