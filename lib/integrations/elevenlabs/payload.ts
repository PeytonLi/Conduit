import { z } from "zod";

/** Payload of a `supplier_call` action record. org/case come from the action, never from here. */
export const supplierCallPayloadSchema = z
  .object({
    contact_id: z.guid(),
    purpose: z.string().trim().min(1).max(200).optional(),
    qty_needed: z.number().int().positive().max(1_000_000_000).optional(),
    needed_by: z.iso.datetime({ offset: true }).optional(),
    allowed_tradeoffs: z.array(z.string().trim().min(1).max(120)).max(8).default([]),
    extra_questions: z.array(z.string().trim().min(1).max(200)).max(5).default([]),
  })
  .strict();

export type SupplierCallPayload = z.infer<typeof supplierCallPayloadSchema>;
