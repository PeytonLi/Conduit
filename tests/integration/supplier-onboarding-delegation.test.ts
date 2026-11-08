import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPlan as createPlanAction, createPlanRequestSchema } from "@/lib/actions/plans";
import { approve, connect, createPlan, deps, FakeClock, pgRpc, seedHarbor, type Harbor } from "./actions.harness";

const client = connect();
const clock = new FakeClock();
const rpc = pgRpc(client);
beforeAll(() => client.connect());
afterAll(() => client.end());

const delegation = {
  enabled: true, ceiling_minor: "10000", currency: "USD", supplier_allowlist: [] as string[],
  hours: { weekdays: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" },
  max_auto_approvals_per_day: 3,
};

async function setPolicy(h: Harbor, changes: Record<string, unknown> = {}) {
  const version = (await client.query("select max(version) v from public.policies where org_id = $1", [h.orgId])).rows[0].v;
  return rpc("policy_create_version", {
    p_org_id: h.orgId, p_actor_user_id: h.ownerId, p_expected_version: version,
    p_settings: { delegated_purchasing: { ...delegation, ...changes } }, p_reason: "Owner opted in", p_now: clock.now().toISOString(),
  }) as Promise<{ ok: boolean; version: number; delegated_commitments_revoked: number }>;
}

async function bridge(h: Harbor) {
  const quoteId = (await client.query(
    `insert into public.quotes (org_id, case_id, supplier_id, contact_id, item_id, quantity, unit,
       unit_price_minor, currency, freight_minor, fees_minor, nonrecoverable_tax_minor,
       destination_location_id, arrival_start, arrival_end, valid_until, latest_order_at, status)
     values ($1, $2, $3, $4, $5, 600, 'carton', 10, 'USD', 0, 0, 0, $6,
       '2026-10-14T13:00:00Z', '2026-10-14T15:00:00Z', '2026-10-12T22:00:00Z', '2026-10-12T21:00:00Z', 'verified') returning id`,
    [h.orgId, h.caseId, h.supplierId, h.contactId, h.itemId, h.locationId],
  )).rows[0].id;
  const steps = [{ step_id: "bridge", kind: "purchase_bridge", quantity: 600, unit: "carton", execution_mode: "manual",
    evidence_ids: [h.evidenceId], depends_on_step_ids: [], payload: { quote_id: quoteId } }];
  const plan = await createPlan(deps(client, clock), h, steps);
  expect(plan).toMatchObject({ ok: true, status: "ready", gross_commitment_minor: "6000" });
  return { plan, quoteId, steps };
}

function onboard(h: Harbor, scope: "contact" | "purchasing", decision = "approve", extras: Record<string, unknown> = {}) {
  return rpc("ui_supplier_approval", {
    p_org: h.orgId, p_supplier: h.supplierId, p_actor: h.ownerId, p_scope: scope,
    p_contact: scope === "contact" ? h.contactId : null, p_decision: decision, p_expected_version: 1,
    p_reason: "Owner reviewed supplier", p_request_id: randomUUID(), ...extras,
  }) as Promise<{ stage: string; row_version: number }>;
}

function auto(h: Harbor, planId: string, now = clock.now().toISOString()) {
  return rpc("approve_plan_delegated", { p_org_id: h.orgId, p_plan_id: planId, p_now: now }) as Promise<{
    ok: boolean; code?: string; denials?: string[]; approval_id: string; replayed?: boolean;
  }>;
}

describe("supplier onboarding and delegated purchasing database contracts", () => {
  it("requires separate owner contact and evidenced purchasing approvals; records immutable history", async () => {
    const h = await seedHarbor(client);
    await client.query("update public.suppliers set purchasing_status = 'candidate' where id = $1", [h.supplierId]);
    await client.query("update public.supplier_contacts set outreach_approved_at = null where supplier_id = $1", [h.supplierId]);
    await expect(onboard(h, "purchasing", "approve", { p_evidence_note: "Terms checked" })).rejects.toThrow("contact_approval_required");
    await expect(onboard(h, "contact", "approve", { p_actor: h.operatorId })).rejects.toThrow("owner_required");
    await expect(onboard(h, "contact")).rejects.toThrow("identity_evidence_required");
    await client.query("update public.evidence set verified_at = now() where id = $1", [h.evidenceId]);
    await client.query("update public.supplier_contacts set identity_evidence_id = $1 where id = $2", [h.evidenceId, h.contactId]);
    expect(await onboard(h, "contact")).toMatchObject({ stage: "contact_approved", row_version: 2 });
    await expect(onboard(h, "purchasing")).rejects.toThrow("onboarding_evidence_required");
    const other = await seedHarbor(client);
    await expect(onboard(h, "purchasing", "approve", { p_evidence_ids: [other.evidenceId] })).rejects.toThrow("evidence_not_found");
    expect(await onboard(h, "purchasing", "approve", { p_evidence_note: "Payment terms and identity checked" }))
      .toMatchObject({ stage: "purchasing_eligible", row_version: 2 });
    const events = (await client.query("select * from public.supplier_onboarding_events where supplier_id = $1 order by occurred_at", [h.supplierId])).rows;
    expect(events.map((row) => row.to_stage)).toEqual(["contact_approved", "purchasing_eligible"]);
    expect(events[0].evidence_ids).toEqual([h.evidenceId]);
    expect(events[1]).toMatchObject({ actor_user_id: h.ownerId, evidence_note: "Payment terms and identity checked" });
    await expect(client.query("update public.supplier_onboarding_events set reason = 'changed' where id = $1", [events[0].id])).rejects.toThrow();
    expect(await onboard(h, "contact", "revoke", { p_expected_version: 2 })).toMatchObject({ stage: "candidate", row_version: 3 });
    expect((await client.query("select purchasing_status from public.suppliers where id = $1", [h.supplierId])).rows[0].purchasing_status).toBe("candidate");
  });

  it("blocks unapproved outreach and purchase commitments even through direct ledger calls", async () => {
    const h = await seedHarbor(client);
    const { plan } = await bridge(h);
    await client.query("update public.suppliers set purchasing_status = 'candidate' where id = $1", [h.supplierId]);
    await client.query("update public.supplier_contacts set outreach_approved_at = null where supplier_id = $1", [h.supplierId]);
    expect(await approve(deps(client, clock), client, h, plan.plan_id)).toMatchObject({ ok: false, code: "supplier_not_purchasable" });
    expect(await rpc("ledger_prepare_action", {
      p_org_id: h.orgId, p_case_id: h.caseId, p_actor_type: "system", p_actor_id: "test", p_kind: "supplier_email",
      p_payload: {}, p_contact_id: h.contactId, p_idempotency_key: randomUUID(), p_now: clock.now().toISOString(),
    })).toMatchObject({ ok: false, code: "policy_denied" });
    await expect(client.query(
      "insert into public.actions (org_id, case_id, plan_id, kind, payload, payload_hash, idempotency_key, mode) values ($1,$2,$3,'manual_export','{}','test',$4,'replay')",
      [h.orgId, h.caseId, plan.plan_id, randomUUID()],
    )).rejects.toThrow("supplier_not_purchasable");
  });

  it("keeps default approval manual and API plan creation auto-approves only after explicit opt-in", async () => {
    const h = await seedHarbor(client);
    const { plan, steps } = await bridge(h);
    expect(await auto(h, plan.plan_id)).toMatchObject({ ok: false, code: "delegation_disabled" });
    expect(await setPolicy(h)).toMatchObject({ ok: true });
    const created = await createPlanAction(deps(client, clock), {
      orgId: h.orgId, caseId: h.caseId, userId: h.operatorId, idempotencyKey: randomUUID(),
      body: createPlanRequestSchema.parse({ assessment_id: h.assessmentId, steps }),
    });
    expect(created).toMatchObject({ ok: true, status: "approved" });
    if (!created.ok) throw new Error(created.message);
    const approval = (await client.query("select * from public.approvals where plan_id = $1", [created.plan_id])).rows[0];
    expect(approval).toMatchObject({ approval_mode: "delegated", approving_user_id: h.ownerId, approved_ceiling_minor: "6000" });
    expect(approval.delegated_policy_version_id).toBeTruthy();
    expect(approval.delegation_basis).toMatchObject({ currency: "USD", ceiling_minor: "10000", supplier_ids: [h.supplierId] });
    expect(await auto(h, created.plan_id)).toMatchObject({ ok: true, replayed: true, approval_id: approval.id });
    expect((await client.query("select event_name from public.audit_events where entity_id = $1", [approval.id])).rows)
      .toContainEqual({ event_name: "plan.approved.delegated" });
  });

  it.each([
    [{ ceiling_minor: "5999" }, "over_ceiling"],
    [{ hours: { weekdays: [2], start: "09:00", end: "17:00" } }, "outside_delegated_hours"],
  ])("denies delegated plans outside configured bounds %j", async (changes, denial) => {
    const h = await seedHarbor(client);
    await setPolicy(h, changes);
    const { plan } = await bridge(h);
    expect(await auto(h, plan.plan_id)).toMatchObject({ ok: false, code: "delegation_not_permitted", denials: expect.arrayContaining([denial]) });
  });

  it("validates currency and tenant allowlists and denies non-allowlisted suppliers", async () => {
    const h = await seedHarbor(client);
    const other = await seedHarbor(client);
    expect(await setPolicy(h, { currency: "EUR" })).toMatchObject({ ok: false });
    expect(await setPolicy(h, { supplier_allowlist: [other.supplierId] })).toMatchObject({ ok: false });
    const allowed = (await client.query("insert into public.suppliers (org_id, name) values ($1, 'Allowed') returning id", [h.orgId])).rows[0].id;
    await setPolicy(h, { supplier_allowlist: [allowed] });
    const { plan } = await bridge(h);
    expect(await auto(h, plan.plan_id)).toMatchObject({ ok: false, denials: expect.arrayContaining(["supplier_not_allowlisted"]) });
  });

  it("rechecks terms, currency, eligibility and owner authority", async () => {
    for (const [mutation, denial] of [
      ["update public.suppliers set purchasing_status = 'blocked' where id = $1", "supplier_not_purchasable"],
      ["update public.quotes set currency = 'EUR' where supplier_id = $1", "currency_mismatch"],
      ["update public.quotes set status = 'provisional' where supplier_id = $1", "unverified_purchase_terms"],
    ]) {
      const h = await seedHarbor(client);
      await setPolicy(h);
      const { plan } = await bridge(h);
      await client.query(mutation, [h.supplierId]);
      expect(await auto(h, plan.plan_id)).toMatchObject({ ok: false, denials: expect.arrayContaining([denial]) });
    }
    const h = await seedHarbor(client);
    await setPolicy(h);
    const { plan } = await bridge(h);
    await client.query("update public.memberships set active = false where auth_user_id = $1", [h.ownerId]);
    expect(await auto(h, plan.plan_id)).toMatchObject({ ok: false, denials: expect.arrayContaining(["delegator_not_owner"]) });
  });

  it("kill switch is owner-only, revokes active approvals, and cancels prepared commitments", async () => {
    const h = await seedHarbor(client);
    await setPolicy(h);
    const { plan } = await bridge(h);
    const approval = await auto(h, plan.plan_id);
    expect(approval.ok).toBe(true);
    const prepared = await rpc("ledger_prepare_action", {
      p_org_id: h.orgId, p_case_id: h.caseId, p_actor_type: "user", p_actor_id: h.operatorId, p_kind: "manual_export",
      p_payload: { plan_id: plan.plan_id }, p_idempotency_key: randomUUID(), p_plan_id: plan.plan_id,
      p_approval_id: approval.approval_id, p_now: clock.now().toISOString(),
    }) as { ok: boolean; action: { id: string } };
    expect(prepared.ok).toBe(true);
    const args = { p_org_id: h.orgId, p_reason: "Emergency stop", p_now: clock.now().toISOString() };
    expect(await rpc("delegation_kill_switch", { ...args, p_actor_user_id: h.operatorId })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await rpc("delegation_kill_switch", { ...args, p_actor_user_id: h.ownerId })).toMatchObject({ ok: true, delegated_commitments_revoked: 1 });
    expect((await client.query("select state from public.actions where id = $1", [prepared.action.id])).rows[0].state).toBe("cancelled");
    expect(await rpc("ledger_claim_dispatch", { p_org_id: h.orgId, p_action_id: prepared.action.id, p_now: clock.now().toISOString() })).toMatchObject({ ok: false, code: "not_claimable" });
    expect(await auto(h, plan.plan_id)).toMatchObject({ ok: false, code: "delegation_disabled" });
  });

  it("any policy change revokes active delegated approvals", async () => {
    const h = await seedHarbor(client);
    await setPolicy(h);
    const { plan } = await bridge(h);
    const approval = await auto(h, plan.plan_id);
    expect(approval.ok).toBe(true);
    expect(await setPolicy(h, { ceiling_minor: "7000" })).toMatchObject({ ok: true, delegated_commitments_revoked: 1 });
    expect((await client.query("select status from public.approvals where id = $1", [approval.approval_id])).rows[0].status).toBe("revoked");
  });

  it("finalizes the planner material snapshot before attempting a delegated approval", async () => {
    const h = await seedHarbor(client);
    await setPolicy(h);
    const { plan } = await bridge(h);
    await client.query("update public.recovery_plans set input_fingerprint = '', policy_version_id = null where id = $1", [plan.plan_id]);
    const finalized = await rpc("plan_finalize", { p_org_id: h.orgId, p_plan_id: plan.plan_id, p_now: clock.now().toISOString() });
    expect(finalized).toMatchObject({ ok: true, plan: { status: "approved", input_fingerprint: expect.stringMatching(/^sha256:/), policy_version_id: expect.any(String) } });
  });

  it("supplier revocation cancels a previously prepared commitment at dispatch", async () => {
    const h = await seedHarbor(client);
    const { plan } = await bridge(h);
    const approval = await approve(deps(client, clock), client, h, plan.plan_id);
    const prepared = await rpc("ledger_prepare_action", {
      p_org_id: h.orgId, p_case_id: h.caseId, p_actor_type: "user", p_actor_id: h.ownerId, p_kind: "manual_export",
      p_payload: { plan_id: plan.plan_id }, p_idempotency_key: randomUUID(), p_plan_id: plan.plan_id,
      p_approval_id: approval.approval_id, p_now: clock.now().toISOString(),
    }) as { ok: boolean; action: { id: string } };
    expect(prepared.ok).toBe(true);
    await onboard(h, "purchasing", "revoke");
    expect(await rpc("ledger_claim_dispatch", { p_org_id: h.orgId, p_action_id: prepared.action.id, p_now: clock.now().toISOString() }))
      .toMatchObject({ ok: false, code: "supplier_not_purchasable" });
    expect((await client.query("select state from public.actions where id = $1", [prepared.action.id])).rows[0].state).toBe("cancelled");
  });

  it("enforces the daily budget across concurrent workers on different plans", async () => {
    const h = await seedHarbor(client);
    await setPolicy(h, { max_auto_approvals_per_day: 1 });
    const first = await bridge(h);
    const locationId = (await client.query("insert into public.locations (org_id, name, timezone) values ($1, 'Second DC', 'America/Chicago') returning id", [h.orgId])).rows[0].id;
    const caseId = (await client.query("insert into public.cases (org_id, item_id, location_id, phase) values ($1, $2, $3, 'recovering') returning id", [h.orgId, h.itemId, locationId])).rows[0].id;
    const assessmentId = (await client.query("insert into public.assessments (org_id, case_id, version, input_fingerprint, quality) values ($1, $2, 1, 'second', 'sufficient') returning id", [h.orgId, caseId])).rows[0].id;
    const second = await bridge({ ...h, caseId, locationId, assessmentId });
    const worker = connect();
    await worker.connect();
    try {
      const results = await Promise.all([
        auto(h, first.plan.plan_id),
        pgRpc(worker)("approve_plan_delegated", { p_org_id: h.orgId, p_plan_id: second.plan.plan_id, p_now: clock.now().toISOString() }),
      ]) as { ok: boolean; denials?: string[] }[];
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.find((result) => !result.ok)?.denials).toContain("daily_limit_reached");
      expect((await client.query("select count(*)::int n from public.approvals where org_id = $1 and approval_mode = 'delegated'", [h.orgId])).rows[0].n).toBe(1);
    } finally {
      await worker.end();
    }
  });

  it("exposes onboarding history only to its tenant and keeps approval RPCs service-only", async () => {
    const h = await seedHarbor(client);
    const other = await seedHarbor(client);
    await onboard(h, "purchasing", "revoke");
    await client.query("begin");
    try {
      await client.query("select set_config('request.jwt.claim.sub', $1, true)", [other.ownerId]);
      await client.query("set local role authenticated");
      expect((await client.query("select id from public.supplier_onboarding_events where org_id = $1", [h.orgId])).rows).toEqual([]);
      await client.query("reset role");
      await client.query("select set_config('request.jwt.claim.sub', $1, true)", [h.ownerId]);
      await client.query("set local role authenticated");
      expect((await client.query("select id from public.supplier_onboarding_events where org_id = $1", [h.orgId])).rows).toHaveLength(1);
    } finally {
      await client.query("rollback");
    }
    for (const fn of ["approve_plan_delegated(uuid,uuid,timestamptz)", "plan_finalize(uuid,uuid,timestamptz)", "delegation_kill_switch(uuid,uuid,text,timestamptz)"]) {
      expect((await client.query("select has_function_privilege('authenticated', $1, 'execute') allowed", [`public.${fn}`])).rows[0].allowed).toBe(false);
    }
  });
});
