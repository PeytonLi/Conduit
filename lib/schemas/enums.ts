import { z } from "zod";

export const casePhaseSchema = z.enum([
  "new",
  "needs_review",
  "assessing",
  "recovering",
  "awaiting_supplier",
  "awaiting_approval",
  "executing",
  "monitoring",
  "closed",
]);
export const runControlSchema = z.enum(["active", "paused", "blocked"]);
export const blockReasonSchema = z.enum([
  "stale_data",
  "missing_data",
  "connection_unavailable",
  "provider_unavailable",
  "budget_exhausted",
  "outcome_unknown",
  "policy_denied",
  "no_feasible_plan",
  "manual_execution_required",
]);
export const actionStateSchema = z.enum([
  "prepared",
  "dispatching",
  "submitted",
  "confirmed",
  "failed",
  "unknown",
  "cancelled",
]);
export const actionKindSchema = z.enum([
  "supplier_email",
  "supplier_call",
  "demo_ledger_amendment",
  "manual_export",
]);
export const assessmentQualitySchema = z.enum(["sufficient", "insufficient"]);
export const planStepKindSchema = z.enum([
  "amend_delivery_schedule",
  "purchase_bridge",
  "transfer_stock",
  "cancel_original_quantity",
]);
export const membershipRoleSchema = z.enum(["owner", "operator", "viewer"]);

export type CasePhase = z.infer<typeof casePhaseSchema>;
export type RunControl = z.infer<typeof runControlSchema>;
export type BlockReason = z.infer<typeof blockReasonSchema>;
export type ActionState = z.infer<typeof actionStateSchema>;
export type ActionKind = z.infer<typeof actionKindSchema>;
export type AssessmentQuality = z.infer<typeof assessmentQualitySchema>;
export type PlanStepKind = z.infer<typeof planStepKindSchema>;
export type MembershipRole = z.infer<typeof membershipRoleSchema>;
