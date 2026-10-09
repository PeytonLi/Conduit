const { Client } = require("pg");
(async () => {
  const c = new Client({ connectionString: "postgresql://postgres:postgres@127.0.0.1:54322/postgres" });
  await c.connect();
  const O = "00000000-0000-4000-8000-000000000001", CASE = "3edc807f-72ee-4ae6-8bee-f4c46a19817a";
  const S = "878a8c37-9bc9-4fd7-9088-97cfb5ce456f", CT = "e9175d00-f8a7-4e67-938b-74d030f3036a";
  const ITEM = "20000000-0000-4000-8000-000000000001", LOC = "10000000-0000-4000-8000-000000000001";
  const cols = async (t) => (await c.query(`select column_name from information_schema.columns where table_schema='public' and table_name=$1 and is_generated='NEVER' order by ordinal_position`, [t])).rows.map(r => r.column_name);
  try {
    await c.query("begin");
    const sc = (await cols("suppliers")).filter(k => !["id","created_at","updated_at","row_version"].includes(k));
    const sExpr = sc.map(k => k === "name" ? `name || ' (sandbox B)'` : k === "external_id" ? `external_id || '-SANDBOX-B'` : k);
    const sb = (await c.query(`insert into public.suppliers (${sc.join(",")}) select ${sExpr.join(",")} from public.suppliers where id=$1 and org_id=$2 returning id`, [S, O])).rows[0].id;
    const cc = (await cols("supplier_contacts")).filter(k => !["id","created_at","updated_at","row_version"].includes(k));
    const cExpr = cc.map(k => k === "supplier_id" ? `'${sb}'::uuid` : k);
    const cb = (await c.query(`insert into public.supplier_contacts (${cc.join(",")}) select ${cExpr.join(",")} from public.supplier_contacts where id=$1 and org_id=$2 returning id`, [CT, O])).rows[0].id;
    const po = (await c.query(`insert into public.purchase_orders (org_id, external_id, supplier_id, currency, source_version) values ($1,'PO-1042-SANDBOX-B',$2,'USD','sandbox-live-proof') returning id`, [O, sb])).rows[0].id;
    const line = (await c.query(`insert into public.purchase_order_lines (org_id, purchase_order_id, external_line_id, item_id, destination_location_id, ordered_qty, unit_price_minor, original_due_at) values ($1,$2,'1',$3,$4,600,42,'2026-10-14T16:00:00Z') returning id`, [O, po, ITEM, LOC])).rows[0].id;
    await c.query(`insert into public.case_order_lines (org_id, case_id, po_line_id, affected_qty) values ($1,$2,$3,600)`, [O, CASE, line]);
    await c.query("commit");
    console.log(JSON.stringify({ supplier_b: sb, contact_b: cb }));
  } catch (e) { await c.query("rollback"); console.error("ROLLBACK:", e.message); process.exitCode = 1; }
  await c.end();
})();
