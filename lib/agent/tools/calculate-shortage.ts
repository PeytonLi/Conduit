import { z } from "zod";
import type { AgentTool } from "./types";
import { ok, fail, type ToolDeps } from "./deps";

interface Input {
  assessment_version: number;
}

export function createCalculateShortageTool(
  deps: ToolDeps,
): AgentTool<Input, unknown> {
  return {
    name: "calculate_shortage",
    spanName: "inventory_calc",
    description:
      "Return the persisted shortage assessment for this case: projection, first shortage, bridge quantity and dated requirements.",
    input: z
      .object({ assessment_version: z.number().int().positive() })
      .strict(),
    async run(ctx, input) {
      const a = await deps.store.getAssessmentByVersion(
        ctx.orgId,
        ctx.caseId,
        input.assessment_version,
      );
      if (!a) return fail("not_found", "assessment not found for this case");
      return ok(
        {
          assessment_id: a.id,
          version: a.version,
          quality: a.quality,
          first_shortage_at: a.first_shortage_at,
          bridge_qty: a.bridge_qty,
          requirements: a.dated_requirements,
          projection: a.projection,
        },
        a.evidence_ids,
      );
    },
  } as AgentTool<Input, unknown>;
}
