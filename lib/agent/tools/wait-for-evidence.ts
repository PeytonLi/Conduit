import { z } from "zod";
import type { AgentTool } from "./types";
import { fail, ok, uuid, type ToolDeps } from "./deps";
import { transitionAllowed } from "../phases";

const KINDS = ["supplier_response", "call_result", "action_outcome"] as const;

interface Input {
  expected_kind: (typeof KINDS)[number];
  action_id?: string;
  deadline_at: string;
}

export function createWaitForEvidenceTool(
  deps: ToolDeps,
): AgentTool<Input, unknown> {
  return {
    name: "wait_for_evidence",
    spanName: "action_prep",
    description:
      "Persist a wake condition: wait for supplier response, call result or action outcome until a clamped deadline.",
    input: z
      .object({
        expected_kind: z.enum(KINDS),
        action_id: uuid.optional(),
        deadline_at: z.string().datetime(),
      })
      .strict(),
    async run(ctx, input) {
      const c = await deps.store.getCase(ctx.orgId, ctx.caseId);
      if (!c) return fail("not_found", "case not found");
      if (input.action_id) {
        const action = await deps.store.getAction(ctx.orgId, ctx.caseId, input.action_id);
        if (!action) return fail("not_found", "action not found for this case");
      }
      const assessment = await deps.store.getCurrentAssessment(ctx.orgId, ctx.caseId);
      let deadline = new Date(input.deadline_at);
      if (assessment?.first_shortage_at) {
        const clamp = new Date(
          new Date(assessment.first_shortage_at).getTime() - 4 * 3600_000,
        );
        if (deadline > clamp) deadline = clamp;
      }
      if (deadline <= deps.clock.now()) {
        return fail("deadline_passed", "clamped deadline is already in the past");
      }
      const wait = await deps.store.insertWait({
        org_id: ctx.orgId,
        case_id: ctx.caseId,
        episode: c.episode,
        expected_kind: input.expected_kind,
        action_id: input.action_id ?? null,
        deadline_at: deadline.toISOString(),
        status: "pending",
        created_at: deps.clock.now().toISOString(),
      });
      if (transitionAllowed(c.phase, "awaiting_supplier")) {
        await deps.store.updateCasePhase(
          ctx.orgId,
          ctx.caseId,
          "awaiting_supplier",
          deadline.toISOString(),
        );
      }
      return ok({ wait_id: wait.id, deadline_at: wait.deadline_at });
    },
  } as AgentTool<Input, unknown>;
}
