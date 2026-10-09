import { z } from "zod";
import type { AgentTool } from "./types";
import { ok, fail, type ToolDeps } from "./deps";

export function createReadCaseTool(
  deps: ToolDeps,
): AgentTool<Record<string, never>, unknown> {
  return {
    name: "read_case",
    spanName: "matching",
    description:
      "Read the current case: phase, run control, versions, next deadline and current assessment summary.",
    input: z.object({}).strict(),
    async run(ctx) {
      const c = await deps.store.getCase(ctx.orgId, ctx.caseId);
      if (!c) return fail("not_found", "case not found");
      const assessment = await deps.store.getCurrentAssessment(ctx.orgId, ctx.caseId);
      return ok({
        phase: c.phase,
        run_control: c.run_control,
        block_reason: c.block_reason,
        row_version: c.row_version,
        episode: c.episode,
        next_check_at: c.next_check_at,
        assessment: assessment
          ? {
              id: assessment.id,
              version: assessment.version,
              quality: assessment.quality,
              first_shortage_at: assessment.first_shortage_at,
              bridge_qty: assessment.bridge_qty,
              requirements: assessment.dated_requirements,
            }
          : null,
      });
    },
  } as AgentTool<Record<string, never>, unknown>;
}
