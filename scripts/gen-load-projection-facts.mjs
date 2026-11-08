import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const sql = fs.readFileSync(path.join(root, "supabase/migrations/20261012130000_f1_imports.sql"), "utf8");
const start = sql.indexOf("create function public.load_projection_facts");
const end = sql.indexOf("revoke all on function public.stage_import");
let body = sql.slice(start, end);
body = body.replace(/^create function/, "create or replace function");
body = body.replace(
  `'base_unit', i.base_unit,
      'specification', i.specification`,
  `'base_unit', i.base_unit,
      'quantity_scale', i.quantity_scale,
      'specification', i.specification`,
);
fs.writeFileSync(
  path.join(root, "supabase/migrations/20261108160200_fractional_load_projection_facts.sql"),
  `-- load_projection_facts: expose item.quantity_scale\n\n${body}`,
);
