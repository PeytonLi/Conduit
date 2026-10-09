import { z } from "zod";

export const eventNames = [
  "supplier.message.received",
  "case.assessment.requested",
  "business.snapshot.activated",
  "case.recovery.requested",
  "supplier.response.recorded",
  "supplier.call.finished",
  "plan.approved",
  "action.reconcile.requested",
  "action.outcome.recorded",
  "receipt.recorded",
  "case.control.changed",
  "policy.changed",
] as const;

export const internalEventEnvelopeSchema = z.object({
  schema_version: z.literal(1),
  event_id: z.string().uuid(),
  org_id: z.string().uuid(),
  aggregate_id: z.string().uuid(),
  occurred_at: z.string().datetime(),
  correlation_id: z.string().uuid(),
  causation_id: z.string().uuid().nullable(),
  name: z.enum(eventNames),
  data: z.record(z.string(), z.unknown()),
});

export type EventName = (typeof eventNames)[number];
export type InternalEventEnvelope = z.infer<typeof internalEventEnvelopeSchema>;
