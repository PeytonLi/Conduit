import { z } from "zod";
import { plannerDecisionSchema, type PlannerDecision } from "@/lib/schemas/planner";
import type { ModelTurn } from "./model";

const uuid = z.string().uuid();

export const toolRequestPayloadSchema = z
  .object({
    tool_name: z.string(),
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();

export const waitPayloadSchema = z
  .object({
    expected_kind: z.enum(["supplier_response", "call_result", "action_outcome"]),
    action_id: uuid.optional(),
    deadline_at: z.string().datetime(),
  })
  .strict();

export const requestReviewPayloadSchema = z
  .object({
    reason: z.string().max(500),
    missing_fields: z.array(z.string()).max(20),
    object_ids: z.array(uuid).max(20),
  })
  .strict();

export const proposePlanPayloadSchema = z
  .object({
    assessment_id: uuid,
    steps: z
      .array(
        z
          .object({
            step_id: z.string(),
            kind: z.enum([
              "amend_delivery_schedule",
              "purchase_bridge",
              "transfer_stock",
              "cancel_original_quantity",
            ]),
            quantity: z.number().int().positive(),
            quote_id: uuid.optional(),
            depends_on_step_ids: z.array(z.string()).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(5),
    evidence_ids: z.array(uuid),
  })
  .strict();

export const noActionPayloadSchema = z.object({}).strict();

export interface ParsedDecision {
  decision: PlannerDecision;
  /** Set when tool_calls contained more than one call; only first is used. */
  extraToolCallsIgnored?: number;
}

export type ParseResult =
  | { ok: true; decision: PlannerDecision; extraToolCallsIgnored?: number }
  | { ok: false; issues: string };

function issueText(error: unknown, raw: string): string {
  const detail =
    error instanceof z.ZodError
      ? error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")
      : error instanceof Error
        ? error.message
        : "invalid output";
  const echo = raw.length > 300 ? `${raw.slice(0, 300)}…` : raw;
  return `${detail} (raw: ${echo})`;
}

const PAYLOAD_SCHEMAS: Record<PlannerDecision["decision_type"], z.ZodType> = {
  tool_request: toolRequestPayloadSchema,
  wait: waitPayloadSchema,
  request_review: requestReviewPayloadSchema,
  propose_plan: proposePlanPayloadSchema,
  no_action: noActionPayloadSchema,
};

/**
 * Parse one model turn into a validated decision. Tool calls take precedence;
 * only the first call is used (side effects are serial). Otherwise content is
 * parsed as a decision JSON object (```json fences stripped).
 */
export function parseModelTurn(turn: ModelTurn): ParseResult {
  const toolCalls = turn.message.tool_calls;
  if (toolCalls && toolCalls.length > 0) {
    const call = toolCalls[0];
    let args: Record<string, unknown>;
    try {
      const parsed = JSON.parse(call.arguments || "{}");
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, issues: "tool call arguments are not a JSON object" };
      }
      args = parsed as Record<string, unknown>;
    } catch (e) {
      return {
        ok: false,
        issues: `tool call arguments are not valid JSON: ${(e as Error).message}`.slice(
          0,
          400,
        ),
      };
    }
    const decision: PlannerDecision = {
      schema_version: 1,
      decision_type: "tool_request",
      concise_reason: "model tool call",
      supporting_evidence_ids: [],
      missing_facts: [],
      payload: { tool_name: call.name, arguments: args },
    };
    return {
      ok: true,
      decision,
      extraToolCallsIgnored: toolCalls.length > 1 ? toolCalls.length - 1 : undefined,
    };
  }

  const content = turn.message.content;
  if (!content) {
    return { ok: false, issues: "empty model output: no tool call, no content" };
  }
  const stripped = content.replace(/```(?:json)?\s*/gi, "").trim();
  let raw: unknown;
  try {
    raw = JSON.parse(stripped);
  } catch (e) {
    return { ok: false, issues: issueText(e, stripped) };
  }
  const parsed = plannerDecisionSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, issues: issueText(parsed.error, stripped) };
  }
  const decision = parsed.data;
  const payloadResult = PAYLOAD_SCHEMAS[decision.decision_type].safeParse(
    decision.payload,
  );
  if (!payloadResult.success) {
    return {
      ok: false,
      issues: issueText(payloadResult.error, JSON.stringify(decision.payload)),
    };
  }
  return { ok: true, decision };
}
