export const requiredColumns = {
  "suppliers.csv": [
    "supplier_id", "name", "purchasing_status", "contact_name", "email", "phone",
    "contact_timezone", "outreach_approved",
  ],
  "items.csv": [
    "item_id", "sku", "description", "base_unit", "length_mm", "width_mm", "height_mm",
    "material_grade",
  ],
  "purchase_orders.csv": ["po_id", "supplier_id", "currency", "status"],
  "purchase_order_lines.csv": [
    "po_id", "line_id", "item_id", "location_id", "ordered_qty", "received_qty",
    "cancelled_qty", "unit_price_minor", "original_due_at",
  ],
  "receipt_schedules.csv": [
    "receipt_id", "po_id", "line_id", "quantity_remaining", "earliest_at", "latest_at",
    "promise_state", "source_reference",
  ],
  "inventory.csv": [
    "item_id", "location_id", "physical_qty", "unusable_qty", "outside_allocations_qty",
    "source_as_of",
  ],
  "demand.csv": [
    "demand_id", "item_id", "location_id", "remaining_qty", "required_at", "certainty",
    "included_reserved_qty", "source_as_of",
  ],
} as const;

export type ImportFile = keyof typeof requiredColumns;
