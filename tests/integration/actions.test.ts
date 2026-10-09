import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyCaseControlEffects } from "@/lib/actions/control";
import { dispatchAction, reconcileAction } from "@/lib/actions/dispatcher";
import { recordOutcome } from "@/lib/actions/ledger";
import { requestOutreach } from "@/lib/actions/outreach";
import { executeApprovedPlan } from "@/lib/actions/plans";
import { consumeOnce, drainOutbox, type PublishedEvent } from "@/lib/workflows/outbox";
import { approve, connect, countingAdapter, createPlan, deps, FakeClock, seedHarbor, type Harbor } from "./actions.harness";

const client = connect();
beforeAll(() => client.connect());
afterAll(() => client.end());

const email = { contact_id: "", channel: "email" as const, message: { subject: "PO 1042", body: "Can you split?" } };
async function outreach(d: ReturnType<typeof deps>, h: Harbor, key = randomUUID(), body = { ...email, contact_id: h.contactId }) {
  return requestOutreach(d, { orgId: h.orgId, caseId: h.caseId, userId: h.operatorId, idempotencyKey: key, body });
}
const actionRow = async (id: string) => (await client.query("select * from public.actions where id = $1", [id])).rows[0];

describe("action dispatch, reconciliation and outbox", () => {
  it("outreach: prepared action when policy allows, reviewable draft otherwise", async () => {
    const clock = new FakeClock();
    const d = deps(client, clock);
    const h = await seedHarbor(client);
    const allowed = await outreach(d, h);
    expect(allowed).toMatchObject({ ok: true, result: "prepared_action", action: { state: "prepared", kind: "supplier_email" } });
    clock.set("2026-10-12T23:30:00Z"); // 18:30 Chicago
    const late = await outreach(d, h);
    expect(late).toMatchObject({ ok: true, result: "draft", denials: ["outside_contact_hours"] });
    const disabled = await seedHarbor(client, { policy: {} });
    expect(await outreach(deps(client, new FakeClock()), disabled)).toMatchObject({ result: "draft", denials: ["channel_disabled"] });
  });

  it("AT-39/NFR-002: crash after prepare, retries and duplicate events produce exactly one external request", async () => {
    const clock = new FakeClock();
    const fake = countingAdapter("supplier_email");
    const d = deps(client, clock, [fake.adapter]);
    const h = await seedHarbor(client);
    const key = randomUUID();
    const prepared = await outreach(d, h, key);
    if (!prepared.ok || prepared.result !== "prepared_action") throw new Error("expected action");
    // Crash before provider call: nothing sent; the retry (and a duplicate request) reuse the same action.
    expect(await outreach(d, h, key)).toMatchObject({ result: "prepared_action", replayed: true, action: { id: prepared.action.id } });
    const runs = await Promise.all([1, 2, 3].map(() => dispatchAction(d, h.orgId, prepared.action.id)));
    expect(runs.filter((r) => r.status === "dispatched")).toHaveLength(1);
    expect(fake.dispatches).toBe(1);
    clock.advance(600);
    const later = await dispatchAction(d, h.orgId, prepared.action.id);
    expect(["reconciled", "terminal"]).toContain(later.status);
    expect((await actionRow(prepared.action.id)).state).toBe("confirmed");
    expect(fake.dispatches).toBe(1);
    expect(await outreach(d, h, key, { ...email, contact_id: h.contactId, message: { subject: "x", body: "different" } })).toMatchObject({ ok: false, code: "idempotency_conflict" });
  });

  it("AT-25: provider accepts then the app crashes: unknown, no blind retry, claims retained, reconciled", async () => {
    const clock = new FakeClock();
    const fake = countingAdapter("demo_ledger_amendment");
    fake.dispatchImpl = async () => { throw new Error("socket hang up"); };
    fake.findImpl = async () => ({ outcome: "unknown", safeSummary: "still unknown" });
    const d = deps(client, clock, [fake.adapter]);
    const h = await seedHarbor(client);
    const plan = await createPlan(d, h);
    const approval = await approve(d, client, h, plan.plan_id);
    const run = await executeApprovedPlan(d, { orgId: h.orgId, planId: plan.plan_id, approvalId: approval.approval_id });
    if (run.status !== "dispatch" || !("action" in run.report)) throw new Error("expected dispatch");
    const id = run.report.action.id;
    expect(run.report.action.state).toBe("unknown");
    for (let i = 0; i < 3; i++) await dispatchAction(d, h.orgId, id);
    expect(fake.dispatches).toBe(1);
    expect(fake.finds).toBe(3);
    const claims = await client.query("select state from public.allocation_claims where action_id = $1", [id]);
    expect(claims.rows.map((r) => r.state)).toEqual(["uncertain"]);
    const c = (await client.query("select run_control, block_reason from public.cases where id = $1", [h.caseId])).rows[0];
    expect(c).toEqual({ run_control: "blocked", block_reason: "outcome_unknown" });
    // Owner resolution requires evidence.
    const noEvidence = await d.rpc("ledger_resolve_action", { p_org_id: h.orgId, p_action_id: id, p_actor_user_id: h.ownerId, p_outcome: "confirmed", p_evidence_id: randomUUID(), p_note: null, p_now: clock.now().toISOString() });
    expect(noEvidence).toMatchObject({ ok: false, code: "evidence_required" });
    const operator = await d.rpc("ledger_resolve_action", { p_org_id: h.orgId, p_action_id: id, p_actor_user_id: h.operatorId, p_outcome: "confirmed", p_evidence_id: h.evidenceId, p_note: null, p_now: clock.now().toISOString() });
    expect(operator).toMatchObject({ ok: false, code: "forbidden" });
    // Readback later finds the result.
    fake.findImpl = async () => ({ outcome: "confirmed", providerRef: "demo:1", safeSummary: "found" });
    expect(await reconcileAction(d, h.orgId, id)).toMatchObject({ status: "reconciled", action: { state: "confirmed" } });
    expect(fake.dispatches).toBe(1);
    const after = await client.query("select state from public.allocation_claims where action_id = $1", [id]);
    expect(after.rows.map((r) => r.state)).toEqual(["consumed"]);
  });

  it("AT-27: pause stops new dispatch, resume re-queues, cancel never rewrites in-flight actions", async () => {
    const clock = new FakeClock();
    const fake = countingAdapter("supplier_email");
    const d = deps(client, clock, [fake.adapter]);
    const h = await seedHarbor(client);
    const queued = await outreach(d, h);
    const inflight = await outreach(d, h);
    if (!queued.ok || !inflight.ok || queued.result !== "prepared_action" || inflight.result !== "prepared_action") throw new Error("expected actions");
    await dispatchAction(d, h.orgId, inflight.action.id); // submitted
    await client.query("update public.cases set run_control = 'paused' where id = $1", [h.caseId]);
    const paused = await applyCaseControlEffects(d, { orgId: h.orgId, caseId: h.caseId, command: "pause", actorUserId: h.ownerId });
    expect(paused).toMatchObject({ ok: true, held_action_ids: [queued.action.id], requires_reconciliation_action_ids: [inflight.action.id] });
    expect(await dispatchAction(d, h.orgId, queued.action.id)).toMatchObject({ status: "held", code: "case_not_active" });
    expect(fake.dispatches).toBe(1);
    await client.query("update public.cases set run_control = 'active' where id = $1", [h.caseId]);
    expect(await applyCaseControlEffects(d, { orgId: h.orgId, caseId: h.caseId, command: "resume", actorUserId: h.ownerId })).toMatchObject({ requeued: true });
    const cancelled = await applyCaseControlEffects(d, { orgId: h.orgId, caseId: h.caseId, command: "cancel", actorUserId: h.ownerId });
    expect(cancelled).toMatchObject({ cancelled_action_ids: [queued.action.id], requires_reconciliation_action_ids: [inflight.action.id] });
    expect((await actionRow(queued.action.id)).state).toBe("cancelled");
    expect((await actionRow(inflight.action.id)).state).toBe("submitted");
    expect((await client.query("select ordered_qty from public.purchase_order_lines where id = $1", [h.poLineId])).rows[0].ordered_qty).toBe(4000);
    // Global dispatch pause blocks new sends too.
    await d.rpc("policy_create_version", { p_org_id: h.orgId, p_actor_user_id: h.ownerId, p_expected_version: 1, p_settings: { dispatch_paused: true, outreach: { email_enabled: true } }, p_reason: "pause", p_now: clock.now().toISOString() });
    expect(await outreach(d, h)).toMatchObject({ result: "draft", denials: expect.arrayContaining(["dispatch_paused"]) });
  });

  it("AT-40: early, duplicate and post-pause callbacks are persisted once and respect control state", async () => {
    const clock = new FakeClock();
    const fake = countingAdapter("supplier_email");
    const d = deps(client, clock, [fake.adapter]);
    const h = await seedHarbor(client);
    const a = await outreach(d, h);
    if (!a.ok || a.result !== "prepared_action") throw new Error("expected action");
    const id = a.action.id;
    await client.query("update public.actions set state = 'dispatching', dispatch_started_at = $2 where id = $1", [id, clock.now().toISOString()]);
    // Callback arrives before the dispatch call returns.
    const early = await recordOutcome(d, h.orgId, id, { outcome: "confirmed", providerRef: "msg-1", safeSummary: "delivered" }, "callback");
    expect(early).toMatchObject({ ok: true, action: { state: "confirmed" } });
    const dup = await recordOutcome(d, h.orgId, id, { outcome: "confirmed", providerRef: "msg-1", safeSummary: "delivered" }, "callback");
    expect(dup).toMatchObject({ ok: true, duplicate: true });
    const late = await recordOutcome(d, h.orgId, id, { outcome: "submitted", providerRef: "msg-1", safeSummary: "late" }, "dispatch");
    expect(late).toMatchObject({ ok: false, code: "outcome_conflict" });
    expect((await actionRow(id)).state).toBe("confirmed");
    // After pause: result recorded but the case stays paused.
    const b = await outreach(d, h);
    if (!b.ok || b.result !== "prepared_action") throw new Error("expected action");
    await dispatchAction(d, h.orgId, b.action.id);
    await client.query("update public.cases set run_control = 'paused' where id = $1", [h.caseId]);
    await recordOutcome(d, h.orgId, b.action.id, { outcome: "confirmed", providerRef: "msg-2", safeSummary: "ok" }, "callback");
    expect((await client.query("select run_control from public.cases where id = $1", [h.caseId])).rows[0].run_control).toBe("paused");
  });

  it("NFR-001: outbox events survive a publisher crash and consumers dedupe by event_id", async () => {
    const clock = new FakeClock();
    const d = deps(client, clock);
    const h = await seedHarbor(client);
    await outreach(d, h);
    const ours = (events: PublishedEvent[]) => events.filter((e) => e.data.org_id === h.orgId);
    const crash = async () => { throw new Error("publisher crashed"); };
    await expect(drainOutbox({ ...d, send: crash }, 500)).rejects.toThrow();
    const sent: PublishedEvent[] = [];
    let drained = 1;
    while (drained > 0) drained = (await drainOutbox({ ...d, send: async (e) => { sent.push(...e); } }, 500)).published;
    const mine = ours(sent);
    expect(mine.map((e) => e.name)).toEqual(expect.arrayContaining(["policy.changed", "action.prepared"]));
    expect(mine.every((e) => e.id === e.data.event_id)).toBe(true);
    const unpublished = await client.query("select count(*)::int n from public.event_outbox where org_id = $1 and published_at is null", [h.orgId]);
    expect(unpublished.rows[0].n).toBe(0);
    const event = mine[0];
    expect(await consumeOnce(d.rpc, "test", h.orgId, event.id)).toBe(true);
    expect(await consumeOnce(d.rpc, "test", h.orgId, event.id)).toBe(false);
  });
});
