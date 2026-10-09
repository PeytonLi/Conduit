import { z } from "zod";

const uuid = z.string().uuid();
const queryBoolean = z.preprocess((value) => {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return value;
}, z.boolean());
const phaseSchema = z.enum([
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

export const caseListQuerySchema = z.object({
  phase: z.array(phaseSchema).optional(),
  severity: z.array(z.enum(["critical", "urgent", "warning", "info", "needs_information"])).optional(),
  assignee: z.union([uuid, z.literal("me"), z.literal("unassigned")]).optional(),
  supplier: uuid.optional(),
  item: uuid.optional(),
  needs_my_decision: queryBoolean.optional(),
  data_stale: queryBoolean.optional(),
  uncertain_action: queryBoolean.optional(),
  closed_outcome: z.enum(["delivered", "no_impact", "accepted_risk", "cancelled", "unresolved"]).optional(),
  q: z.string().trim().max(200).optional(),
  include_closed: queryBoolean.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});

export const caseControlRequestSchema = z.object({
  command: z.enum(["pause", "resume", "assign", "close", "reopen"]),
  expected_version: z.number().int().positive(),
  reason: z.string().trim().max(2000).optional(),
  assignee_user_id: uuid.nullable().optional(),
  outcome: z.enum(["no_impact", "accepted_risk", "cancelled", "unresolved", "delivered"]).optional(),
});

export const reassessRequestSchema = z.object({
  expected_version: z.number().int().positive(),
  reason: z.string().trim().min(1).max(2000),
});

export const membershipRoleRequestSchema = z.object({
  role: z.enum(["owner", "operator", "viewer"]),
  active: z.boolean(),
  expected_version: z.number().int().positive(),
  reason: z.string().trim().min(1).max(2000),
});

export const supplierApprovalRequestSchema = z.object({
  scope: z.enum(["contact", "purchasing"]),
  contact_id: uuid.nullable().optional(),
  decision: z.enum(["approve", "block", "revoke"]),
  expected_version: z.number().int().positive(),
  reason: z.string().trim().min(1).max(2000),
});

export const demoRunRequestSchema = z.object({
  fixture_id: z.enum(["harbor-pack-canonical", "harbor-pack-harmless"]),
  reset: z.boolean(),
  plan_expires_at: z.string().datetime().optional(),
});

export const activityQuerySchema = z.object({
  case_id: uuid.optional(),
  actor: z.string().trim().min(1).max(200).optional(),
  outcome: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});

export type CaseListQuery = z.infer<typeof caseListQuerySchema>;
export type CaseControlRequest = z.infer<typeof caseControlRequestSchema>;
export type ReassessRequest = z.infer<typeof reassessRequestSchema>;
export type MembershipRoleRequest = z.infer<typeof membershipRoleRequestSchema>;
export type SupplierApprovalRequest = z.infer<typeof supplierApprovalRequestSchema>;
export type DemoRunRequest = z.infer<typeof demoRunRequestSchema>;
export type ActivityQuery = z.infer<typeof activityQuerySchema>;
