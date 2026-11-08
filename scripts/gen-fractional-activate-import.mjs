import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const sql = fs.readFileSync(path.join(root, "supabase/migrations/20261012130000_f1_imports.sql"), "utf8");
const start = sql.indexOf("create function public.activate_import");
const end = sql.indexOf("create function public.load_projection_facts");
let body = sql.slice(start, end);
body = body.replace(/^create function/, "create or replace function");
const qtyFields = [
  "ordered_qty",
  "received_qty",
  "cancelled_qty",
  "quantity_remaining",
  "physical_qty",
  "unusable_qty",
  "outside_allocations_qty",
  "remaining_qty",
  "included_reserved_qty",
];
const prefixes = ["v_line", "v_receipt", "v_inventory", "v_demand"];
for (const prefix of prefixes) {
  for (const field of qtyFields) {
    body = body.replaceAll(`(${prefix}->>'${field}')::integer`, `(${prefix}->>'${field}')::numeric(18,6)`);
  }
}
body = body.replace(
  "insert into public.items (org_id, sku, external_id, description, base_unit, specification)",
  "insert into public.items (org_id, sku, external_id, description, base_unit, quantity_scale, specification)",
);
body = body.replace(
  `        v_item->>'base_unit',
        coalesce(v_item->'specification', '{}'::jsonb)`,
  `        v_item->>'base_unit',
        coalesce((v_item->>'quantity_scale')::smallint, 0),
        coalesce(v_item->'specification', '{}'::jsonb)`,
);
body = body.replace(
  `             base_unit = v_item->>'base_unit',
             specification = coalesce(v_item->'specification', '{}'::jsonb),`,
  `             base_unit = v_item->>'base_unit',
             quantity_scale = coalesce((v_item->>'quantity_scale')::smallint, public.items.quantity_scale),
             specification = coalesce(v_item->'specification', '{}'::jsonb),`,
);
body = body.replace(
  `            base_unit = excluded.base_unit,
            specification = excluded.specification,`,
  `            base_unit = excluded.base_unit,
            quantity_scale = excluded.quantity_scale,
            specification = excluded.specification,`,
);

const out = `-- Patched activate_import for numeric(18,6) quantities and item.quantity_scale.\n\n${body}`;
fs.writeFileSync(path.join(root, "supabase/migrations/20261108160100_fractional_import_activate.sql"), out);
console.log("wrote activate_import patch", out.length, "bytes");
