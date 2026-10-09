import { z } from "zod";
import type { AgentTool } from "./types";
import { fail, ok, uuid, type ToolDeps } from "./deps";
import { evaluateQuote } from "../quote-evaluation";

interface Input {
  quote_id: string;
}

export function createEvaluateQuoteTool(
  deps: ToolDeps,
): AgentTool<Input, unknown> {
  return {
    name: "evaluate_quote",
    spanName: "quote_validation",
    description:
      "Deterministically evaluate a quote of this case: missing terms, expiry, landed cost and feasibility.",
    input: z.object({ quote_id: uuid }).strict(),
    async run(ctx, input) {
      const c = await deps.store.getCase(ctx.orgId, ctx.caseId);
      if (!c) return fail("not_found", "case not found");
      const quote = await deps.store.getQuote(ctx.orgId, ctx.caseId, input.quote_id);
      if (!quote) return fail("not_found", "quote not found for this case");
      const item = await deps.store.getItem(ctx.orgId, quote.item_id);
      if (!item) return fail("not_found", "item not found");
      const evaluation = evaluateQuote(quote, item, deps.clock.now());
      return ok({ quote_id: quote.id, ...evaluation }, quote.evidence_ids);
    },
  } as AgentTool<Input, unknown>;
}
