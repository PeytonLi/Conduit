const { Client } = require("pg");
(async () => {
  const c = new Client({ connectionString: "postgresql://postgres:postgres@127.0.0.1:54322/postgres" });
  await c.connect();
  const O = "00000000-0000-4000-8000-000000000001", OLD = "3edc807f-72ee-4ae6-8bee-f4c46a19817a";
  const ITEM = "20000000-0000-4000-8000-000000000001", LOC = "10000000-0000-4000-8000-000000000001";
  const skip = ["id","created_at","updated_at","row_version"];
  const cols = async (t) => (await c.query(`select column_name from information_schema.columns where table_schema='public' and table_name=$1 and is_generated='NEVER' order by ordinal_position`, [t])).rows.map(r => r.column_name).filter(k => !skip.includes(k));
  try {
    await c.query("begin");
    const lc = await cols("locations");
    const lexpr = lc.map(k => k === "name" ? `name || ' (sandbox B)'` : k === "external_id" ? `external_id || '-SANDBOX-B'` : k);
    const loc = (await c.query(`insert into public.locations (${lc.join(",")}) select ${lexpr.join(",")} from public.locations where id=$1 and org_id=$2 returning id`, [LOC, O])).rows[0].id;
    const cs = (await c.query(`insert into public.cases (org_id, item_id, location_id, run_control, severity) values ($1,$2,$3,'active','warning') returning id`, [O, ITEM, loc])).rows[0].id;
    const ac = (await cols("assessments")).filter(k => k !== "case_id" && k !== "version" && k !== "input_fingerprint");
    const as = (await c.query(`insert into public.assessments (case_id, version, input_fingerprint, ${ac.join(",")})
      select $1::uuid, 1, 'live-voice-prep:' || $1::uuid::text || ':1', ${ac.join(",")} from public.assessments a
      where a.id = (select current_assessment_id from public.cases where id=$2 and org_id=$3) returning id`, [cs, OLD, O])).rows[0].id;
    await c.query(`update public.cases set current_assessment_id=$1 where id=$2 and org_id=$3`, [as, cs, O]);
    const po = (await c.query(`select id from public.purchase_orders where org_id=$1 and external_id='PO-1042'`, [O])).rows[0].id;
    const line = (await c.query(`insert into public.purchase_order_lines (org_id, purchase_order_id, external_line_id, item_id, destination_location_id, ordered_qty, unit_price_minor, original_due_at) values ($1,$2,'2',$3,$4,4000,35,'2026-10-13T15:00:00Z') returning id`, [O, po, ITEM, loc])).rows[0].id;
    await c.query(`insert into public.case_order_lines (org_id, case_id, po_line_id, affected_qty) values ($1,$2,$3,4000)`, [O, cs, line]);
    await c.query("commit");
    const chk = (await c.query(`select c.phase, c.run_control, a.bridge_qty, a.first_shortage_at from public.cases c join public.assessments a on a.id=c.current_assessment_id where c.id=$1`, [cs])).rows[0];
    console.log(JSON.stringify({ case_b: cs, location_b: loc, ...chk }));
  } catch (e) { await c.query("rollback"); console.error("ROLLBACK:", e.message); process.exitCode = 1; }
  await c.end();
})();
