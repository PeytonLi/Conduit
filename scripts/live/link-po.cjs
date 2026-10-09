const { Client } = require("pg");
(async () => {
  const c = new Client({ connectionString: "postgresql://postgres:postgres@127.0.0.1:54322/postgres" });
  await c.connect();
  const O = "00000000-0000-4000-8000-000000000001", CASE = "3edc807f-72ee-4ae6-8bee-f4c46a19817a";
  const S = "878a8c37-9bc9-4fd7-9088-97cfb5ce456f", ITEM = "20000000-0000-4000-8000-000000000001", LOC = "10000000-0000-4000-8000-000000000001";
  await c.query("begin");
  const po = await c.query(`insert into public.purchase_orders (org_id, external_id, supplier_id, currency, source_version)
    values ($1,'PO-1042',$2,'USD','sandbox-live-proof') on conflict (org_id, external_id) do update set source_version=excluded.source_version returning id`, [O, S]);
  const line = await c.query(`insert into public.purchase_order_lines (org_id, purchase_order_id, external_line_id, item_id, destination_location_id, ordered_qty, unit_price_minor, original_due_at)
    values ($1,$2,'1',$3,$4,4000,35,'2026-10-13T15:00:00Z') on conflict (org_id, purchase_order_id, external_line_id) do update set ordered_qty=excluded.ordered_qty returning id`, [O, po.rows[0].id, ITEM, LOC]);
  await c.query(`insert into public.case_order_lines (org_id, case_id, po_line_id, affected_qty) values ($1,$2,$3,4000) on conflict do nothing`, [O, CASE, line.rows[0].id]);
  await c.query("commit");
  const chk = await c.query(`select po.external_id po_ref, pol.external_line_id line_ref, pol.ordered_qty - pol.received_qty - pol.cancelled_qty remaining
    from public.case_order_lines col join public.purchase_order_lines pol on pol.id=col.po_line_id and pol.org_id=col.org_id
    join public.purchase_orders po on po.id=pol.purchase_order_id and po.org_id=pol.org_id
    join public.supplier_contacts sc on sc.supplier_id=po.supplier_id and sc.org_id=po.org_id
    where col.org_id=$1 and col.case_id=$2 and sc.id='e9175d00-f8a7-4e67-938b-74d030f3036a'`, [O, CASE]);
  console.log(JSON.stringify(chk.rows));
  await c.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
