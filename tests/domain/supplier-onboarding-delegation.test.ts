import { describe, expect, it, vi } from "vitest";
import { supplierOnboardingStage } from "@/lib/domain/supplier-onboarding";
import { supplierApprovalRequestSchema } from "@/lib/db/queries/contracts";
import { defaultPolicySettings, policySettingsSchema } from "@/lib/policies/schema";
import { delegationKillSwitchHandler, type HandlerDeps } from "@/lib/actions/api/handlers";
import { AuthorizationError } from "@/lib/auth/membership";
import { SupabasePlannerStore } from "@/lib/agent/store-supabase";
import type { SupabaseClient } from "@supabase/supabase-js";

describe("supplier onboarding and delegated policy contracts", () => {
  it("finalizes persisted planner steps and returns the database approval status", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { ok: true, plan: { id: "plan", status: "approved" } }, error: null });
    const writes: string[] = [];
    const store = new SupabasePlannerStore({
      from: (table: string) => ({ insert: () => {
        writes.push(table);
        return table === "recovery_plans"
          ? { select: () => ({ single: async () => ({ data: { id: "plan", status: "ready" }, error: null }) }) }
          : Promise.resolve({ error: null });
      } }), rpc,
    } as unknown as SupabaseClient);
    const plan = await store.insertRecoveryPlan({
      orgId: "org", caseId: "case", version: 1, assessmentId: "assessment", status: "ready",
      now: "2026-10-12T15:00:00.000Z", grossCommitmentMinor: "6000", incrementalCostMinor: "6000", evidenceIds: [],
      steps: [{ step_id: "bridge", kind: "purchase_bridge", item_id: "item", quantity: 600, unit: "carton", missing_fields: [] }],
    });
    expect(writes).toEqual(["recovery_plans", "plan_steps"]);
    expect(rpc).toHaveBeenCalledWith("plan_finalize", { p_org_id: "org", p_plan_id: "plan", p_now: "2026-10-12T15:00:00.000Z" });
    expect(plan.status).toBe("approved");
  });

  it("derives separate contact and purchasing stages", () => {
    expect(supplierOnboardingStage("candidate", false)).toBe("candidate");
    expect(supplierOnboardingStage("candidate", true)).toBe("contact_approved");
    expect(supplierOnboardingStage("approved", true)).toBe("purchasing_eligible");
    expect(supplierOnboardingStage("blocked", true)).toBe("blocked");
  });

  it("requires purchasing evidence and a specific contact for outreach decisions", () => {
    const request = { scope: "purchasing", decision: "approve", expected_version: 1, reason: "Reviewed" };
    expect(supplierApprovalRequestSchema.safeParse(request).success).toBe(false);
    expect(supplierApprovalRequestSchema.safeParse({ ...request, evidence_note: "Identity and payment terms reviewed" }).success).toBe(true);
    expect(supplierApprovalRequestSchema.safeParse({ ...request, scope: "contact" }).success).toBe(false);
    expect(supplierApprovalRequestSchema.safeParse({ ...request, decision: "revoke" }).success).toBe(true);
  });

  it("defaults off and validates bounded opt-in settings without granting operator authority", () => {
    expect(defaultPolicySettings.delegated_purchasing.enabled).toBe(false);
    expect(policySettingsSchema.safeParse({ delegated_purchasing: { enabled: true } }).success).toBe(false);
    const delegation = { enabled: true, ceiling_minor: "10000", currency: "USD", supplier_allowlist: [] };
    expect(policySettingsSchema.parse({ delegated_purchasing: delegation }).delegated_purchasing).toMatchObject(delegation);
    for (const invalid of [
      { ceiling_minor: "0" }, { ceiling_minor: "1.50" }, { ceiling_minor: "1000000000000000" },
      { currency: "usd" }, { supplier_allowlist: ["foreign"] }, { max_auto_approvals_per_day: 21 },
      { hours: { start: "17:00", end: "09:00" } }, { hours: { weekdays: [] } },
    ]) {
      expect(policySettingsSchema.safeParse({ delegated_purchasing: { ...delegation, ...invalid } }).success).toBe(false);
    }
    expect(policySettingsSchema.safeParse({ commitment_authority: "operator" }).success).toBe(false);
    expect(policySettingsSchema.safeParse({ budgets: { autonomous_commitment_minor: "1" } }).success).toBe(false);
  });

  it("authenticates emergency disable and passes server identity and time to the RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({ ok: true, version: 2, delegated_commitments_revoked: 1 });
    const publish = vi.fn();
    const auth = vi.fn().mockResolvedValue({ orgId: "org", userId: "owner", role: "owner" });
    const deps = { auth, publish, ledger: { rpc, clock: { now: () => new Date("2026-11-09T15:00:00Z") } } } as unknown as HandlerDeps;
    const request = () => new Request("http://localhost/api/v1/policies/delegation/disable", {
      method: "POST", body: JSON.stringify({ reason: "Stop purchasing" }),
    });
    expect((await delegationKillSwitchHandler(deps, request())).status).toBe(200);
    expect(auth).toHaveBeenCalledWith(["owner"]);
    expect(rpc).toHaveBeenCalledWith("delegation_kill_switch", {
      p_org_id: "org", p_actor_user_id: "owner", p_reason: "Stop purchasing", p_now: "2026-11-09T15:00:00.000Z",
    });
    expect(publish).toHaveBeenCalledOnce();
    auth.mockRejectedValue(new AuthorizationError());
    expect((await delegationKillSwitchHandler(deps, request())).status).toBe(403);
    expect(rpc).toHaveBeenCalledOnce();
  });
});
