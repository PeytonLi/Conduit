import { z } from "zod";
import type { AgentTool } from "./types";
import { fail, ok, uuid, type ToolDeps } from "./deps";

const inputSchema = z
  .object({
    supplier_id: uuid,
    contact_id: uuid.optional(),
    source_evidence_id: uuid,
    quantity: z.number().int().positive(),
    unit: z.string(),
    unit_price_minor: z.string().regex(/^\d+$/),
    currency: z.string().regex(/^[A-Z]{3}$/),
    freight_minor: z.string().regex(/^\d+$/).optional(),
    fees_minor: z.string().regex(/^\d+$/).optional(),
    nonrecoverable_tax_minor: z.string().regex(/^\d+$/).optional(),
    arrival_start: z.string().datetime().optional(),
    arrival_end: z.string().datetime().optional(),
    valid_until: z.string().datetime().optional(),
    latest_order_at: z.string().datetime().optional(),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export function createRecordProvisionalOfferTool(
  deps: ToolDeps,
): AgentTool<Input, unknown> {
  return {
    name: "record_provisional_offer",
    spanName: "quote_validation",
    description:
      "Record a sourced supplier offer as a provisional offer + quote. Quotes are always 'provisional'; no status field is accepted.",
    input: inputSchema,
    async run(ctx, rawInput) {
      const parsed = inputSchema.safeParse(rawInput);
      if (!parsed.success) return fail("invalid_arguments", "invalid offer input");
      const input = parsed.data;
      const c = await deps.store.getCase(ctx.orgId, ctx.caseId);
      if (!c) return fail("not_found", "case not found");
      const link = await deps.store.findCaseEvidence(
        ctx.orgId,
        ctx.caseId,
        input.source_evidence_id,
      );
      if (!link) {
        return fail("not_found", "source evidence not linked to this case");
      }
      const supplier = await deps.store.getSupplier(ctx.orgId, input.supplier_id);
      if (!supplier) return fail("not_found", "supplier not found");
      const item = await deps.store.getItem(ctx.orgId, c.item_id);
      if (!item) return fail("not_found", "item not found");
      if (input.unit !== item.base_unit) {
        return fail("unit_mismatch", "unit does not match item base unit");
      }

      const offer = await deps.store.insertOffer({
        org_id: ctx.orgId,
        case_id: ctx.caseId,
        supplier_id: input.supplier_id,
        contact_id: input.contact_id ?? null,
        evidence_ids: [input.source_evidence_id],
        source_type: "supplier",
        source_summary: "provisional offer recorded by planner",
      });
      const quote = await deps.store.insertQuote({
        org_id: ctx.orgId,
        case_id: ctx.caseId,
        offer_id: offer.id,
        supplier_id: input.supplier_id,
        contact_id: input.contact_id ?? null,
        item_id: item.id,
        quantity: input.quantity,
        unit: input.unit,
        unit_price_minor: input.unit_price_minor,
        currency: input.currency,
        freight_minor: input.freight_minor ?? null,
        fees_minor: input.fees_minor ?? null,
        nonrecoverable_tax_minor: input.nonrecoverable_tax_minor ?? null,
        destination_location_id: c.location_id,
        arrival_start: input.arrival_start ?? null,
        arrival_end: input.arrival_end ?? null,
        valid_until: input.valid_until ?? null,
        latest_order_at: input.latest_order_at ?? null,
        status: "provisional",
        evidence_ids: [input.source_evidence_id],
      });
      return ok(
        { offer_id: offer.id, quote_id: quote.id, status: quote.status },
        [input.source_evidence_id],
      );
    },
  } as AgentTool<Input, unknown>;
}
