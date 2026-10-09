import { z } from "zod";
import type { AgentTool } from "./types";
import { ok, uuid, type ToolDeps } from "./deps";

interface Input {
  source_message_id: string;
  order_refs: string[];
  item_refs: string[];
}

export function createFindOrderCandidatesTool(
  deps: ToolDeps,
): AgentTool<Input, unknown> {
  return {
    name: "find_order_candidates",
    spanName: "matching",
    description:
      "Match extracted order/item references to exact PO external ids and item SKUs in this org.",
    input: z
      .object({
        source_message_id: uuid,
        order_refs: z.array(z.string()).max(5),
        item_refs: z.array(z.string()).max(5),
      })
      .strict(),
    async run(ctx, input) {
      const lines = await deps.store.findOrderCandidates(
        ctx.orgId,
        input.order_refs,
        input.item_refs,
      );
      return ok({
        candidates: lines.map((l) => ({
          po_line_id: l.po_line_id,
          matched_refs: [
            ...(input.order_refs.includes(l.purchase_order_external_id)
              ? [l.purchase_order_external_id]
              : []),
            ...(input.item_refs.includes(l.item_sku) ? [l.item_sku] : []),
          ],
        })),
      });
    },
  } as AgentTool<Input, unknown>;
}
