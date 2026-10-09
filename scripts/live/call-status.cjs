const { Client } = require("pg");
(async () => {
  const c = new Client({ connectionString: "postgresql://postgres:postgres@127.0.0.1:54322/postgres" });
  await c.connect();
  const A = "8de03fcb-8588-4745-bcb2-e7214a4333a4";
  const tabs = (await c.query(`select table_name from information_schema.columns where table_schema='public' and column_name='action_id' and table_name ~ '(call|voice|offer|tool)'`)).rows.map(r => r.table_name);
  for (const t of tabs) {
    const r = await c.query(`select * from public.${t} where action_id=$1`, [A]);
    for (const row of r.rows) {
      for (const k of Object.keys(row)) if (/token|secret|hash|phone|address|transcript|raw|payload/i.test(k)) row[k] = row[k] == null ? null : "[redacted]";
    }
    console.log(t, JSON.stringify(r.rows));
  }
  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });
