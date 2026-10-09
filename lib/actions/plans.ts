import { z } from "zod";
import { amendDeliveryScheduleSchema } from "@/lib/integrations/business/amendment";
import { buildManualExecutionPacket, type ManualExecutionPacket } from "@/lib/integrations/business/manual-packet";
import { dispatchAction, type DispatcherDeps, type DispatchReport } from "./dispatcher";
import { prepareAction, type LedgerAction } from "./ledger";
import { callLedger, type LedgerFailure } from "./rpc";

const uuid = z.string().uuid();
const minor = z.string().regex(/^\d+$/, "Money is integer minor units");

export const planStepInputSchema = z
  .object({
    step_id: z.string().trim().min(1).max(64),
    kind: z.enum(["amend_delivery_schedule", "purchase_bridge", "transfer_stock", "cancel_original_quantity"]),
    item_id: uuid.optional(),
    quantity: z.number().int().min(0).max(1_000_000_000).nullable(),
    unit: z.string().trim().min(1).max(32).default("each"),
    destination_location_id: uuid.optional(),
    depends_on_step_ids: z.array(z.string().min(1).max(64)).max(10).default([]),
    evidence_ids: z.array(uuid).max(20).default([]),
    execution_mode: z.enum(["demo_ledger", "live_connector", "manual"]),
    payload: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const createPlanRequestSchema = z
  .object({ assessment_id: uuid, steps: z.array(planStepInputSchema).min(1).max(10) })
  .strict()
  .superRefine((value, ctx) => {
    const ids = new Set(value.steps.map((s) => s.step_id));
    if (ids.size !== value.steps.length) ctx.addIssue({ code: "custom", message: "Step ids must be unique", path: ["steps"] });
    value.steps.forEach((step, index) => {
      if (step.depends_on_step_ids.some((d) => !ids.has(d) || d === step.step_id)) {
        ctx.addIssue({ code: "custom", message: "Unknown step dependency", path: ["steps", index, "depends_on_step_ids"] });
      }
      if (step.execution_mode === "demo_ledger") {
        const parsed = amendDeliveryScheduleSchema.safeParse({ change_kind: "amend_delivery_schedule", ...step.payload });
        if (!parsed.success) {
          ctx.addIssue({ code: "custom", message: "Invalid delivery schedule amendment", path: ["steps", index, "payload"] });
        }
      }
    });
  });

export const approvePlanRequestSchema = z
  .object({
    plan_version: z.number().int().positive(),
    input_fingerprint: z.string().min(1).max(200),
    approved_ceiling_minor: minor,
    expected_version: z.number().int().positive(),
  })
  .strict();

export const rejectPlanRequestSchema = z
  .object({ expected_version: z.number().int().positive(), reason: z.string().trim().min(1).max(500) })
  .strict();

export interface PlanView {
  id: string;
  case_id: string;
  version: number;
  status: string;
  row_version: number;
  input_fingerprint: string;
  gross_commitment_minor: string | null;
  incremental_cost_minor: string | null;
  expires_at: string | null;
  currency: string;
  mode: "replay" | "sandbox" | "live";
  steps: {
    step_id: string;
    kind: string;
    item_id: string;
    quantity: number | null;
    unit: string;
    destination_location_id: string | null;
    depends_on_step_ids: string[];
    execution_mode: "demo_ledger" | "live_connector" | "manual";
    payload: Record<string, unknown>;
    missing_fields: string[];
  }[];
  approvals: { id: string; status: string; expires_at: string; consumed_by_action_id: string | null }[];
  actions: { id: string; kind: string; state: string; plan_step_id: string | null }[];
}

const nowIso = (deps: DispatcherDeps) => deps.clock.now().toISOString();

export function createPlan(
  deps: DispatcherDeps,
  input: { orgId: string; caseId: string; userId: string; idempotencyKey: string; body: z.infer<typeof createPlanRequestSchema> },
) {
  return callLedger<{ plan_id: string; version: number; status: string; input_fingerprint: string; replayed?: boolean }>(
    deps.rpc,
    "plan_create",
    {
      p_org_id: input.orgId,
      p_case_id: input.caseId,
      p_actor_user_id: input.userId,
      p_assessment_id: input.body.assessment_id,
      p_steps: input.body.steps,
      p_idempotency_key: input.idempotencyKey,
      p_now: nowIso(deps),
    },
  );
}

export function getPlan(deps: DispatcherDeps, orgId: string, planId: string) {
  return callLedger<{ plan: PlanView }>(deps.rpc, "plan_get", { p_org_id: orgId, p_plan_id: planId });
}

export function approvePlan(
  deps: DispatcherDeps,
  input: { orgId: string; planId: string; userId: string; idempotencyKey: string; body: z.infer<typeof approvePlanRequestSchema> },
) {
  return callLedger<{ approval_id: string; expires_at: string; status: string; replayed?: boolean }>(deps.rpc, "approve_plan", {
    p_org_id: input.orgId,
    p_plan_id: input.planId,
    p_actor_user_id: input.userId,
    p_plan_version: input.body.plan_version,
    p_input_fingerprint: input.body.input_fingerprint,
    p_approved_ceiling_minor: input.body.approved_ceiling_minor,
    p_expected_version: input.body.expected_version,
    p_idempotency_key: input.idempotencyKey,
    p_now: nowIso(deps),
  });
}

export function rejectPlan(
  deps: DispatcherDeps,
  input: { orgId: string; planId: string; userId: string; body: z.infer<typeof rejectPlanRequestSchema> },
) {
  return callLedger<{ plan_id: string; status: string }>(deps.rpc, "reject_plan", {
    p_org_id: input.orgId,
    p_plan_id: input.planId,
    p_actor_user_id: input.userId,
    p_expected_version: input.body.expected_version,
    p_reason: input.body.reason,
    p_now: nowIso(deps),
  });
}

export const stepIdempotencyKey = (plan: Pick<PlanView, "id" | "version">, stepId: string) =>
  `plan:${plan.id}:v${plan.version}:step:${stepId}`;

/**
 * Runs after plan.approved: prepares (revalidating the fingerprint inside the transaction) and
 * dispatches the single automated demo-ledger write, if any. Manual steps wait for export.
 */
export async function executeApprovedPlan(
  deps: DispatcherDeps,
  input: { orgId: string; planId: string; approvalId: string },
): Promise<{ status: "no_automated_step" } | { status: "prepare_failed"; failure: LedgerFailure } | { status: "dispatch"; report: DispatchReport }> {
  const read = await getPlan(deps, input.orgId, input.planId);
  if (!read.ok) return { status: "prepare_failed", failure: read };
  const step = read.plan.steps.find((s) => s.execution_mode === "demo_ledger");
  if (!step) return { status: "no_automated_step" };
  const prepared = await prepareAction(deps, {
    orgId: input.orgId,
    actor: { type: "system", id: "execution" },
    caseId: read.plan.case_id,
    kind: "demo_ledger_amendment",
    payload: { change_kind: "amend_delivery_schedule", ...step.payload },
    idempotencyKey: stepIdempotencyKey(read.plan, step.step_id),
    planId: input.planId,
    planStepId: step.step_id,
    approvalId: input.approvalId,
  });
  if (!prepared.ok) return { status: "prepare_failed", failure: prepared };
  return { status: "dispatch", report: await dispatchAction(deps, input.orgId, prepared.action.id) };
}

export type ExportResult =
  | { ok: true; action: LedgerAction; packet: ManualExecutionPacket; replayed: boolean }
  | LedgerFailure;

/** Creates a manual_export action for an approved plan and returns its manual execution packet. */
export async function exportPlan(
  deps: DispatcherDeps,
  input: { orgId: string; planId: string; userId: string; idempotencyKey: string },
): Promise<ExportResult> {
  const read = await getPlan(deps, input.orgId, input.planId);
  if (!read.ok) return read;
  const plan = read.plan;
  const exported = plan.actions.find((a) => a.kind === "manual_export" && a.state !== "cancelled" && a.state !== "failed");
  const approval =
    plan.approvals.find((a) => a.status === "active") ??
    plan.approvals.find((a) => a.consumed_by_action_id && a.consumed_by_action_id === exported?.id);
  if (!approval) {
    return { ok: false, code: "approval_required", message: "An owner must approve the plan before export" };
  }
  const steps = plan.steps.map((s) => ({
    step_id: s.step_id,
    kind: s.kind,
    item_id: s.item_id,
    quantity: s.quantity,
    unit: s.unit,
    destination_location_id: s.destination_location_id,
    depends_on_step_ids: s.depends_on_step_ids,
    payload: s.payload,
  }));
  const prepared = await prepareAction(deps, {
    orgId: input.orgId,
    actor: { type: "user", id: input.userId },
    caseId: plan.case_id,
    kind: "manual_export",
    payload: { plan_id: plan.id, plan_version: plan.version, steps },
    idempotencyKey: input.idempotencyKey,
    planId: plan.id,
    approvalId: approval.id,
  });
  if (!prepared.ok) return prepared;
  const report = await dispatchAction(deps, input.orgId, prepared.action.id);
  const action = "action" in report ? report.action : prepared.action;
  const packet = buildManualExecutionPacket({
    orgId: input.orgId,
    caseId: plan.case_id,
    planId: plan.id,
    planVersion: plan.version,
    actionId: action.id,
    currency: plan.currency,
    grossCommitmentMinor: plan.gross_commitment_minor,
    steps,
    generatedAt: action.created_at,
  });
  return { ok: true, action, packet, replayed: prepared.replayed };
}
