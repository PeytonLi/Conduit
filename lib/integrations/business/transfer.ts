import { z } from "zod";

const isoDate = z.string().datetime({ offset: true });

/**
 * Terms of a transfer_stock plan step (docs/prd/03 section 7.1): source, expected arrival and
 * handling cost. The quantity, item and destination live on the step itself. The owner approves
 * exactly these terms; execution never reads anything the model produced.
 */
export const transferStockPayloadSchema = z
  .object({
    change_kind: z.literal("transfer_stock"),
    source_location_id: z.string().uuid(),
    /** Latest expected arrival at the destination. Unknown timing makes the option incomplete. */
    arrival_end: isoDate,
    arrival_start: isoDate.optional(),
    transfer_cost_minor: z.string().regex(/^\d+$/, "Money is integer minor units"),
    /** Evidence row that records the source stock this step relied on. */
    source_coverage_evidence_id: z.string().uuid().optional(),
    demand_ids: z.array(z.string().uuid()).optional(),
    summary: z.string().trim().max(300).optional(),
  })
  .strict()
  .refine((value) => !value.arrival_start || Date.parse(value.arrival_start) <= Date.parse(value.arrival_end), {
    message: "The arrival window must start before it ends",
    path: ["arrival_start"],
  });

export type TransferStockPayload = z.infer<typeof transferStockPayloadSchema>;
