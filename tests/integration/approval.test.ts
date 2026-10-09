import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatchAction } from "@/lib/actions/dispatcher";
import { executeApprovedPlan } from "@/lib/actions/plans";
import { approve, connect, createPlan, deps, FakeClock, planRow, seedHarbor, splitStep } from "./actions.harness";

const client = connect();
beforeAll(() => client.connect());
afterAll(() => client.end());

describe("approval binding and revalidation", () => {
  it("AT-19: owner approval is idempotent, operators are denied, one commit action, expiry requires renewal", async () => {
    const clock = new FakeClock();
    const d = deps(client, clock);
    const h = await seedHarbor(client);
    const plan = await createPlan(d, h);
    expect(plan).toMatchObject({ ok: true, status: "ready", gross_commitment_minor: "7500" });

    const denied = await approve(d, client, h, plan.plan_id, { user: h.operatorId });
    expect(denied).toMatchObject({ ok: false, code: "forbidden" });
    expect(await approve(d, client, h, plan.plan_id, { ceiling: "7499" })).toMatchObject({ ok: false, code: "ceiling_too_low" });

    const key = randomUUID();
    const first = await approve(d, client, h, plan.plan_id, { key });
    expect(first.ok).toBe(true);
    expect(Date.parse(first.expires_at) - clock.now().getTime()).toBe(30 * 60 * 1000);
    const again = await approve(d, client, h, plan.plan_id, { key, expected: 1 });
    expect(again).toMatchObject({ ok: true, replayed: true, approval_id: first.approval_id });
    expect(await approve(d, client, h, plan.plan_id, { key, ceiling: "9000", expected: 1 })).toMatchObject({
      ok: false,
      code: "idempotency_conflict",
    });
    expect((await approve(d, client, h, plan.plan_id)).code).toBe("invalid_state");

    const run1 = await executeApprovedPlan(d, { orgId: h.orgId, planId: plan.plan_id, approvalId: first.approval_id });
    const run2 = await executeApprovedPlan(d, { orgId: h.orgId, planId: plan.plan_id, approvalId: first.approval_id });
    expect(run1.status).toBe("dispatch");
    expect(run2.status).toBe("dispatch");
    const actions = await client.query("select id from public.actions where plan_id = $1", [plan.plan_id]);
    expect(actions.rowCount).toBe(1);
    const approval = (await client.query("select * from public.approvals where id = $1", [first.approval_id])).rows[0];
    expect(approval.status).toBe("consumed");
    expect(approval.consumed_by_action_id).toBe(actions.rows[0].id);
  });

  it("AT-19: an approval that expires before dispatch cancels the attempt and requires renewal", async () => {
    const clock = new FakeClock();
    const d = deps(client, clock);
    const h = await seedHarbor(client);
    const plan = await createPlan(d, h);
    const approval = await approve(d, client, h, plan.plan_id);
    clock.advance(31 * 60);
    const result = await executeApprovedPlan(d, { orgId: h.orgId, planId: plan.plan_id, approvalId: approval.approval_id });
    expect(result).toMatchObject({ status: "prepare_failed", failure: { code: "approval_expired" } });
    expect((await planRow(client, plan.plan_id)).status).toBe("ready");
    const renewed = await approve(d, client, h, plan.plan_id);
    expect(renewed.ok).toBe(true);
  });

  it("AT-19: expiry between prepare and dispatch cancels the prepared action and releases claims", async () => {
    const clock = new FakeClock();
    const d = deps(client, clock);
    const h = await seedHarbor(client);
    const plan = await createPlan(d, h);
    const approval = await approve(d, client, h, plan.plan_id);
    const prepared = (await d.rpc("ledger_prepare_action", {
      p_org_id: h.orgId, p_actor_type: "system", p_actor_id: "test", p_case_id: h.caseId,
      p_kind: "demo_ledger_amendment", p_payload: { change_kind: "amend_delivery_schedule", ...splitStep(h).payload },
      p_idempotency_key: randomUUID(), p_contact_id: null, p_plan_id: plan.plan_id, p_plan_step_id: "split",
      p_approval_id: approval.approval_id, p_now: clock.now().toISOString(),
    })) as { ok: boolean; action: { id: string } };
    expect(prepared.ok).toBe(true);
    clock.advance(30 * 60);
    const report = await dispatchAction(d, h.orgId, prepared.action.id);
    expect(report).toMatchObject({ status: "held", code: "approval_expired", action: { state: "cancelled" } });
    const claims = await client.query("select state from public.allocation_claims where action_id = $1", [prepared.action.id]);
    expect(claims.rows.map((r) => r.state)).toEqual(["released"]);
    expect((await client.query("select count(*)::int n from public.demo_ledger_entries where action_id = $1", [prepared.action.id])).rows[0].n).toBe(0);
  });

  it("AT-21: a material change after approval invalidates execution; the old approval cannot authorize new terms", async () => {
    for (const mutate of [
      "update public.demand_requirements set remaining_qty = 500 where id = $1",
      "update public.inventory_snapshots set physical_qty = 550 where dataset_id = $2",
      "update public.receipt_schedules set earliest_at = '2026-10-17T15:00:00Z', latest_at = '2026-10-17T22:00:00Z' where po_line_id = $3",
    ]) {
      const clock = new FakeClock();
      const d = deps(client, clock);
      const h = await seedHarbor(client);
      const plan = await createPlan(d, h);
      const approval = await approve(d, client, h, plan.plan_id);
      await client.query(mutate.replace(/\$2/g, `'${h.datasetId}'`).replace(/\$3/g, `'${h.poLineId}'`).replace(/\$1/g, `'${h.demandIds[1]}'`));
      const result = await executeApprovedPlan(d, { orgId: h.orgId, planId: plan.plan_id, approvalId: approval.approval_id });
      expect(result).toMatchObject({ status: "prepare_failed", failure: { code: "stale_fingerprint" } });
      expect((await planRow(client, plan.plan_id)).status).toBe("expired");
      const appr = (await client.query("select status from public.approvals where id = $1", [approval.approval_id])).rows[0];
      expect(appr.status).toBe("revoked");
      expect((await client.query("select count(*)::int n from public.actions where plan_id = $1", [plan.plan_id])).rows[0].n).toBe(0);
    }
  });

  it("AT-21: a policy change after approval invalidates the approval", async () => {
    const clock = new FakeClock();
    const d = deps(client, clock);
    const h = await seedHarbor(client);
    const plan = await createPlan(d, h);
    const approval = await approve(d, client, h, plan.plan_id);
    const changed = (await d.rpc("policy_create_version", {
      p_org_id: h.orgId, p_actor_user_id: h.ownerId, p_expected_version: 1,
      p_settings: { outreach: { email_enabled: false } }, p_reason: "tighten", p_now: clock.now().toISOString(),
    })) as { ok: boolean; version: number };
    expect(changed).toMatchObject({ ok: true, version: 2 });
    const result = await executeApprovedPlan(d, { orgId: h.orgId, planId: plan.plan_id, approvalId: approval.approval_id });
    expect(result).toMatchObject({ status: "prepare_failed", failure: { code: "stale_fingerprint" } });
  });

  it("policies are versioned, owner-only and optimistic", async () => {
    const d = deps(client, new FakeClock());
    const h = await seedHarbor(client);
    const args = { p_org_id: h.orgId, p_settings: {}, p_reason: "x", p_now: new FakeClock().now().toISOString() };
    expect(await d.rpc("policy_create_version", { ...args, p_actor_user_id: h.operatorId, p_expected_version: 1 })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await d.rpc("policy_create_version", { ...args, p_actor_user_id: h.ownerId, p_expected_version: 0 })).toMatchObject({ ok: false, code: "stale_version" });
    const versions = await client.query("select version from public.policies where org_id = $1 order by version", [h.orgId]);
    expect(versions.rows.map((r) => r.version)).toEqual([1]);
  });

  it("AT-34: two workers on one plan produce one commitment; overlapping claims from another plan are rejected", async () => {
    const clock = new FakeClock();
    const h = await seedHarbor(client);
    const d = deps(client, clock);
    const plan = await createPlan(d, h);
    const approval = await approve(d, client, h, plan.plan_id);
    const second = connect();
    await second.connect();
    try {
      const d2 = deps(second, clock);
      const results = await Promise.all([
        executeApprovedPlan(d, { orgId: h.orgId, planId: plan.plan_id, approvalId: approval.approval_id }),
        executeApprovedPlan(d2, { orgId: h.orgId, planId: plan.plan_id, approvalId: approval.approval_id }),
      ]);
      expect(results.every((r) => r.status === "dispatch")).toBe(true);
    } finally {
      await second.end();
    }
    expect((await client.query("select count(*)::int n from public.actions where plan_id = $1", [plan.plan_id])).rows[0].n).toBe(1);
    expect((await client.query("select count(*)::int n from public.demo_ledger_entries where org_id = $1", [h.orgId])).rows[0].n).toBe(1);

    // A different plan in the same org claiming the same demand is rejected (no double allocation).
    const h2 = await seedHarbor(client);
    const p1 = await createPlan(d, h2, [splitStep(h2, "manual")]);
    const a1 = await approve(d, client, h2, p1.plan_id);
    const prepare = (planId: string, approvalId: string) =>
      d.rpc("ledger_prepare_action", {
        p_org_id: h2.orgId, p_actor_type: "user", p_actor_id: h2.ownerId, p_case_id: h2.caseId, p_kind: "manual_export",
        p_payload: { plan_id: planId }, p_idempotency_key: randomUUID(), p_contact_id: null, p_plan_id: planId,
        p_plan_step_id: null, p_approval_id: approvalId, p_now: clock.now().toISOString(),
      }) as Promise<{ ok: boolean; code?: string }>;
    expect((await prepare(p1.plan_id, a1.approval_id)).ok).toBe(true);
    const otherLocation = (await client.query(
      "insert into public.locations (org_id, name, timezone) values ($1, 'Overflow DC', 'America/Chicago') returning id",
      [h2.orgId],
    )).rows[0].id;
    const otherCase = (await client.query(
      "insert into public.cases (org_id, item_id, location_id, phase) values ($1, $2, $3, 'recovering') returning id",
      [h2.orgId, h2.itemId, otherLocation],
    )).rows[0].id;
    const assessment = (await client.query(
      "insert into public.assessments (org_id, case_id, version, input_fingerprint, quality) values ($1, $2, 1, 'x', 'sufficient') returning id",
      [h2.orgId, otherCase],
    )).rows[0].id;
    const p2 = (await d.rpc("plan_create", {
      p_org_id: h2.orgId, p_case_id: otherCase, p_actor_user_id: h2.ownerId, p_assessment_id: assessment,
      p_steps: [{ ...splitStep(h2, "manual"), destination_location_id: h2.locationId }],
      p_idempotency_key: randomUUID(), p_now: clock.now().toISOString(),
    })) as { plan_id: string };
    const a2 = await approve(d, client, { ...h2, caseId: otherCase }, p2.plan_id);
    const conflict = (await d.rpc("ledger_prepare_action", {
      p_org_id: h2.orgId, p_actor_type: "user", p_actor_id: h2.ownerId, p_case_id: otherCase, p_kind: "manual_export",
      p_payload: { plan_id: p2.plan_id }, p_idempotency_key: randomUUID(), p_contact_id: null, p_plan_id: p2.plan_id,
      p_plan_step_id: null, p_approval_id: a2.approval_id, p_now: clock.now().toISOString(),
    })) as { ok: boolean; code?: string };
    expect(conflict).toMatchObject({ ok: false, code: "allocation_conflict" });
    const a2row = (await client.query("select status from public.approvals where id = $1", [a2.approval_id])).rows[0];
    expect(a2row.status).toBe("active");
  });

  it("B0 rejects plans with more than one automated business write", async () => {
    const d = deps(client, new FakeClock());
    const h = await seedHarbor(client);
    const result = await createPlan(d, h, [splitStep(h), { ...splitStep(h), step_id: "split-2" }]);
    expect(result).toMatchObject({ ok: false, code: "multi_write_not_supported" });
  });
});
