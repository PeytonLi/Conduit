import { z } from "zod";

const isoDate = z.string().datetime({ offset: true });

/** Payload for an amend_delivery_schedule change (e.g. 600 Wednesday + 3,400 Friday). */
export const amendDeliveryScheduleSchema = z
  .object({
    change_kind: z.literal("amend_delivery_schedule"),
    po_line_id: z.string().uuid(),
    receipt_schedule_id: z.string().uuid(),
    supplier_confirmation_evidence_id: z.string().uuid(),
    added_cost_minor: z.string().regex(/^\d+$/).optional(),
    demand_ids: z.array(z.string().uuid()).optional(),
    schedules: z
      .array(
        z.object({
          quantity: z.number().int().positive().max(1_000_000_000),
          earliest_at: isoDate,
          latest_at: isoDate,
        }),
      )
      .min(1)
      .max(10),
  })
  .strict()
  .refine((value) => value.schedules.every((s) => Date.parse(s.earliest_at) <= Date.parse(s.latest_at)), {
    message: "Each schedule window must start before it ends",
    path: ["schedules"],
  });

export type AmendDeliverySchedule = z.infer<typeof amendDeliveryScheduleSchema>;
