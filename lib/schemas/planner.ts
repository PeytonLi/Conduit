import { z } from "zod";

export const plannerDecisionSchema = z.object({
  schema_version: z.literal(1),
  decision_type: z.enum([
    "tool_request",
    "wait",
    "request_review",
    "propose_plan",
    "no_action",
  ]),
  concise_reason: z.string(),
  supporting_evidence_ids: z.array(z.string().uuid()),
  missing_facts: z.array(z.string()),
  payload: z.record(z.string(), z.unknown()),
});

export type PlannerDecision = z.infer<typeof plannerDecisionSchema>;
