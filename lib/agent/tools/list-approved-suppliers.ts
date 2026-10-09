import { z } from "zod";
import type { AgentTool } from "./types";
import { ok, fail, uuid, type ToolDeps } from "./deps";

interface Input {
  item_id: string;
  destination_location_id: string;
}

export function createListApprovedSuppliersTool(
  deps: ToolDeps,
): AgentTool<Input, unknown> {
  return {
    name: "list_approved_suppliers",
    spanName: "source_retrieval",
    description:
      "List approved suppliers that carry the case item, with outreach-allowed contacts (no raw addresses).",
    input: z
      .object({ item_id: uuid, destination_location_id: uuid })
      .strict(),
    async run(ctx, input) {
      const c = await deps.store.getCase(ctx.orgId, ctx.caseId);
      if (!c) return fail("not_found", "case not found");
      if (c.item_id !== input.item_id || c.location_id !== input.destination_location_id) {
        return fail("case_mismatch", "item/destination do not match the case");
      }
      const suppliers = await deps.store.listApprovedSuppliers(
        ctx.orgId,
        input.item_id,
      );
      return ok({
        suppliers: suppliers.map(({ supplier, contacts }) => ({
          supplier_id: supplier.id,
          name: supplier.name,
          contacts: contacts.map((ct) => ({
            id: ct.id,
            channel: ct.channel,
            timezone: ct.timezone,
            display_name: ct.display_name,
            outreach_allowed: true,
          })),
        })),
      });
    },
  } as AgentTool<Input, unknown>;
}
