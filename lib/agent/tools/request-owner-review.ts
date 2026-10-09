import { z } from "zod";
import type { AgentTool } from "./types";
import { ok, fail, uuid, type ToolDeps } from "./deps";
import { transitionAllowed } from "../phases";

interface Input {
  reason: string;
  missing_fields: string[];
  object_ids: string[];
}

export function createRequestOwnerReviewTool(
  deps: ToolDeps,
): AgentTool<Input, unknown> {
  return {
    name: "request_owner_review",
    spanName: "action_prep",
    description: "Raise a visible owner review task. No financial effect.",
    input: z
      .object({
        reason: z.string().max(500),
        missing_fields: z.array(z.string()).max(20),
        object_ids: z.array(uuid).max(20),
      })
      .strict(),
    async run(ctx, input) {
      const c = await deps.store.getCase(ctx.orgId, ctx.caseId);
      if (!c) return fail("not_found", "case not found");
      const review = await deps.store.insertReview({
        org_id: ctx.orgId,
        case_id: ctx.caseId,
        reason: input.reason,
        missing_fields: input.missing_fields,
        object_ids: input.object_ids,
        status: "open",
        created_by: "planner",
      });
      if (transitionAllowed(c.phase, "needs_review") && c.phase !== "needs_review") {
        await deps.store.updateCasePhase(ctx.orgId, ctx.caseId, "needs_review");
      }
      return ok({ review_id: review.id });
    },
  } as AgentTool<Input, unknown>;
}
