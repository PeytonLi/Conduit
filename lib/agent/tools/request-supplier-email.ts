import { z } from "zod";
import type { AgentTool } from "./types";
import { fail, limitsOf, ok, uuid, type ToolDeps } from "./deps";
import { createActionPreparer } from "../ports";

const PURPOSES = [
  "availability_request",
  "written_confirmation",
  "follow_up",
] as const;
const REQUIRED_FIELDS = [
  "quantity",
  "arrival",
  "freight",
  "split_delivery",
  "quote_validity",
  "order_cutoff",
  "written_confirmation",
] as const;

interface Input {
  contact_id: string;
  purpose: (typeof PURPOSES)[number];
  required_fields: (typeof REQUIRED_FIELDS)[number][];
}

export function createRequestSupplierEmailTool(
  deps: ToolDeps,
): AgentTool<Input, unknown> {
  return {
    name: "request_supplier_email",
    spanName: "action_prep",
    description:
      "Prepare (never dispatch) a supplier outreach email action to an approved contact.",
    input: z
      .object({
        contact_id: uuid,
        purpose: z.enum(PURPOSES),
        required_fields: z.array(z.enum(REQUIRED_FIELDS)).min(1).max(7),
      })
      .strict(),
    async run(ctx, input) {
      const limits = limitsOf(deps);
      const c = await deps.store.getCase(ctx.orgId, ctx.caseId);
      if (!c) return fail("not_found", "case not found");
      const contact = await deps.store.getContact(ctx.orgId, input.contact_id);
      if (!contact) return fail("not_found", "contact not found");
      if (contact.channel !== "email" || !contact.permitted_channels.includes("email")) {
        return fail("channel_not_permitted", "email channel not permitted for contact");
      }
      if (!contact.outreach_approved_at) {
        return fail("not_approved", "contact outreach not approved");
      }
      const supplier = await deps.store.getSupplier(ctx.orgId, contact.supplier_id);
      if (!supplier || supplier.purchasing_status !== "approved") {
        return fail("not_approved", "supplier not approved for outreach");
      }

      // Outreach budgets are per episode — only count this episode's actions.
      const actions = (await deps.store.listActions(ctx.orgId, ctx.caseId)).filter(
        (a) => a.payload?.episode === c.episode,
      );
      const emailsToSupplier = actions.filter(
        (a) => a.kind === "supplier_email" && a.payload?.supplier_id === supplier.id,
      );
      if (emailsToSupplier.length >= limits.emailsPerSupplier) {
        return fail("budget_exhausted", "email budget exhausted for supplier");
      }
      const contacted = new Set<string>();
      for (const a of actions) {
        if (
          (a.kind === "supplier_email" || a.kind === "supplier_call") &&
          typeof a.payload?.supplier_id === "string"
        ) {
          contacted.add(a.payload.supplier_id);
        }
      }
      if (!contacted.has(supplier.id) && contacted.size >= limits.distinctSuppliersPerEpisode) {
        return fail("budget_exhausted", "distinct supplier limit reached for episode");
      }

      const assessment = await deps.store.getCurrentAssessment(ctx.orgId, ctx.caseId);
      const item = await deps.store.getItem(ctx.orgId, c.item_id);
      const preparer = deps.preparer ?? createActionPreparer(deps.store);
      const prepared = await preparer.prepare({
        orgId: ctx.orgId,
        caseId: ctx.caseId,
        kind: "supplier_email",
        idempotencyKey: `${ctx.caseId}:${c.episode}:email:${contact.id}:${input.purpose}`,
        mode: ctx.mode,
        payload: {
          recipient: contact.normalized_address,
          contact_id: contact.id,
          supplier_id: supplier.id,
          episode: c.episode,
          purpose: input.purpose,
          required_fields: input.required_fields,
          item: item
            ? {
                sku: item.sku,
                description: item.description,
                specification: item.specification,
                base_unit: item.base_unit,
              }
            : null,
          needed_qty: assessment?.bridge_qty ?? null,
          deadline: assessment?.first_shortage_at ?? null,
        },
      });
      return ok({
        action_id: prepared.actionId,
        state: prepared.state,
        created: prepared.created,
      });
    },
  } as AgentTool<Input, unknown>;
}
