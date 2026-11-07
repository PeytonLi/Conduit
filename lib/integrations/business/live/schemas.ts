import { z } from "zod";

const id = z.string().trim().min(1).max(200);
const qty = z.number().int().min(0).max(1_000_000_000);
const instant = z.string().datetime({ offset: true });

export const erpSnapshotSchema = z.object({
  as_of: instant,
  locations: z.array(z.object({ external_id: id, name: z.string().trim().min(1).max(200) })),
  items: z.array(
    z.object({
      external_id: id,
      sku: z.string().trim().min(1).max(200),
      name: z.string().trim().min(1).max(500),
      unit: z.string().trim().min(1).max(50),
    }),
  ),
  suppliers: z.array(
    z.object({
      external_id: id,
      name: z.string().trim().min(1).max(200),
      email: z.string().nullable().optional(),
      phone: z.string().nullable().optional(),
    }),
  ),
  purchase_orders: z.array(
    z.object({
      external_id: id,
      supplier_external_id: id,
      currency: z.string().regex(/^[A-Z]{3}$/),
      status: z.string().min(1).max(100),
      version: z.string().min(1).max(200),
      lines: z.array(
        z
          .object({
            external_line_id: id,
            item_external_id: id,
            ordered_qty: qty,
            received_qty: qty,
            unit_price_minor: z.string().regex(/^\d+$/),
            due_at: instant.nullable(),
            destination_external_id: id,
          })
          .refine((l) => l.received_qty <= l.ordered_qty, "received_qty exceeds ordered_qty"),
      ),
    }),
  ),
  stock: z.array(
    z
      .object({
        item_external_id: id,
        location_external_id: id,
        on_hand_qty: qty,
        unusable_qty: qty.optional(),
      })
      .refine((s) => (s.unusable_qty ?? 0) <= s.on_hand_qty, "unusable_qty exceeds on_hand_qty"),
  ),
  demand: z.array(
    z.object({
      external_id: id,
      item_external_id: id,
      location_external_id: id,
      quantity: qty,
      required_at: instant,
      certainty: z.enum(["confirmed", "forecast"]),
    }),
  ),
});

export const erpReceiptSchema = z.object({
  external_receipt_id: id,
  po_external_id: id,
  line_external_id: id,
  quantity: z.number().int().positive().max(1_000_000_000),
  received_at: instant,
  kind: z.enum(["received", "reversal"]),
  reverses_external_id: id.optional(),
});

const delivery = z.object({
  external_ref: z.string().min(1),
  quantity: z.number().int().min(0),
  due_at: z.string().nullable(),
});

export const deliverySplitResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("applied"), provider_ref: z.string().min(1), version: z.string(), deliveries: z.array(delivery) }),
  z.object({ status: z.literal("conflict"), current_version: z.string().nullable(), message: z.string() }),
  z.object({ status: z.literal("rejected"), code: z.string(), message: z.string() }),
  z.object({ status: z.literal("unknown"), message: z.string() }),
]);

export const changeLookupSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("applied"), provider_ref: z.string().min(1), deliveries: z.array(delivery) }),
  z.object({ status: z.literal("not_found") }),
]);
