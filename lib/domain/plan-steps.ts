import { z } from "zod";
import { parseMinorUnits } from "./money";

const nullableText = z.string().nullable();
const quantity = z.number().int().min(0).max(1_000_000_000).nullable();
const money = z.string().regex(/^\d+$/).transform((value) => parseMinorUnits(value)).nullable();
const arrivalWindow = z.object({
  start: nullableText,
  end: nullableText,
});
const common = {
  step_id: z.string().min(1),
  item_id: nullableText,
  quantity,
  unit: nullableText,
  destination_location_id: nullableText,
  depends_on_step_ids: z.array(z.string()),
  evidence_ids: z.array(z.string()),
  execution_mode: z.enum(["demo_ledger", "live_connector", "manual"]),
  missing_fields: z.array(z.string()),
};

export const amendDeliveryScheduleStepSchema = z.object({
  ...common,
  kind: z.literal("amend_delivery_schedule"),
  po_line_id: nullableText,
  schedule: z.array(z.object({
    quantity,
    earliest_at: nullableText,
    latest_at: nullableText,
    date_only: z.boolean().optional(),
  })).nullable(),
  added_freight_minor: money,
  supplier_confirmation_evidence_id: nullableText,
});

export const purchaseBridgeStepSchema = z.object({
  ...common,
  kind: z.literal("purchase_bridge"),
  supplier_id: nullableText,
  contact_id: nullableText,
  quote_id: nullableText,
  quote_version: z.number().int().positive().nullable(),
  arrival_window: arrivalWindow.nullable(),
  landed_cost_minor: money,
  original_order_disposition: z.enum(["unchanged", "reduce_via_cancel_step"]).nullable(),
});

export const transferStockStepSchema = z.object({
  ...common,
  kind: z.literal("transfer_stock"),
  source_location_id: nullableText,
  arrival_window: arrivalWindow.nullable(),
  transfer_cost_minor: money,
  source_coverage_evidence: nullableText,
});

export const cancelOriginalQuantityStepSchema = z.object({
  ...common,
  kind: z.literal("cancel_original_quantity"),
  po_line_id: nullableText,
  cancellation_quantity: quantity,
  confirmed_credit_minor: money,
  cancellation_fee_minor: money,
  supplier_acceptance_evidence_id: nullableText,
});

export const planStepSchema = z.discriminatedUnion("kind", [
  amendDeliveryScheduleStepSchema,
  purchaseBridgeStepSchema,
  transferStockStepSchema,
  cancelOriginalQuantityStepSchema,
]);

export type PlanStep = z.infer<typeof planStepSchema>;
