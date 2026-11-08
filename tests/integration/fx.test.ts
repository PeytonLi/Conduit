import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approve, connect, createPlan, deps, FakeClock, pgRpc, seedHarbor, splitStep } from "./actions.harness";

const client = connect();
beforeAll(() => client.connect());
afterAll(() => client.end());

describe("FX plan and approval ledger", () => {
  it("requires an owner, rejects missing/stale FX, snapshots conversion and expires approval with the rate", async () => {
    const h = await seedHarbor(client);
    const clock = new FakeClock();
    const d = deps(client, clock);
    const rpc = pgRpc(client);
    const step = { ...splitStep(h, "manual"), payload: { ...splitStep(h).payload, currency: "EUR" } };
    const missing = await createPlan(d, h, [step]);
    expect(missing).toMatchObject({ ok: true, status: "draft", gross_commitment_minor: null });
    expect(missing.missing_fields).toContain("fx_rate_missing");
    const record = (actor: string, asOf: string, denominator = "10") => rpc("fx_rate_record", {
      p_org_id: h.orgId, p_actor_user_id: actor, p_from_currency: "EUR", p_numerator: "11",
      p_denominator: denominator, p_as_of: asOf, p_source: "Owner bank statement", p_now: clock.now().toISOString(),
    });
    expect(await record(h.operatorId, clock.now().toISOString())).toMatchObject({ ok: false, code: "forbidden" });
    expect(await record(h.ownerId, clock.now().toISOString(), "0")).toMatchObject({ ok: false, code: "validation_failed" });
    await client.query("update organizations set fx_max_age_seconds = 3600 where id = $1", [h.orgId]);
    expect(await record(h.ownerId, "2026-10-12T13:00:00Z")).toMatchObject({ ok: true });
    expect((await createPlan(d, h, [step])).missing_fields).toContain("fx_rate_stale");
    expect(await record(h.ownerId, "2026-10-12T14:30:00Z")).toMatchObject({ ok: true });
    const plan = await createPlan(d, h, [step]);
    expect(plan).toMatchObject({ ok: true, status: "ready", gross_commitment_minor: "8250" });
    expect(await approve(d, client, h, plan.plan_id, { ceiling: "7500" })).toMatchObject({ code: "ceiling_too_low" });
    const approved = await approve(d, client, h, plan.plan_id, { ceiling: "8250" });
    expect(approved.ok).toBe(true);
    expect(new Date(approved.expires_at).getTime()).toBe(clock.now().getTime() + 1800000);
    const row = (await client.query("select * from approvals where id = $1", [approved.approval_id])).rows[0];
    expect(row.currency).toBe("USD");
    expect(row.conversion_evidence[0].cost_conversion.gross).toMatchObject({
      original_minor: "7500", original_currency: "EUR", converted_minor: "8250",
      rate: { source: "Owner bank statement", numerator: "11", denominator: "10" },
    });
    await expect(client.query("update fx_rates set source='changed' where org_id=$1", [h.orgId]))
      .rejects.toThrow("FX evidence is immutable");
    const before = (await rpc("plan_material_fingerprint", { p_org_id: h.orgId, p_plan_id: plan.plan_id }));
    await client.query("update organizations set fx_max_age_seconds = 7200 where id = $1", [h.orgId]);
    expect(await rpc("plan_material_fingerprint", { p_org_id: h.orgId, p_plan_id: plan.plan_id })).not.toBe(before);
  });

  it("converts foreign purchase quotes and leaves missing rates incomplete", async () => {
    const h = await seedHarbor(client);
    const d = deps(client, new FakeClock());
    const quoteId = randomUUID();
    await client.query(`insert into quotes(id,org_id,case_id,supplier_id,contact_id,item_id,quantity,unit,
      unit_price_minor,currency,freight_minor,fees_minor,nonrecoverable_tax_minor,destination_location_id,
      valid_until,latest_order_at,status) values($1,$2,$3,$4,$5,$6,600,'carton',10,'EUR',0,0,0,$7,
      '2026-10-13T15:00:00Z','2026-10-13T15:00:00Z','verified')`,
    [quoteId,h.orgId,h.caseId,h.supplierId,h.contactId,h.itemId,h.locationId]);
    const step = { ...splitStep(h,"manual"), kind: "purchase_bridge", payload: { quote_id: quoteId } };
    expect((await createPlan(d,h,[step])).missing_fields).toContain("fx_rate_missing");
    await pgRpc(client)("fx_rate_record", { p_org_id:h.orgId,p_actor_user_id:h.ownerId,p_from_currency:"EUR",
      p_numerator:"2",p_denominator:"1",p_as_of:d.clock.now().toISOString(),p_source:"Owner test",p_now:d.clock.now().toISOString() });
    expect(await createPlan(d,h,[step])).toMatchObject({ status:"ready",gross_commitment_minor:"12000" });
    const usdQuote = randomUUID();
    await client.query(`insert into quotes select (jsonb_populate_record(null::quotes,
      to_jsonb(q) || jsonb_build_object('id', $2::text, 'currency', 'USD'))).* from quotes q where id=$1`,
    [quoteId, usdQuote]);
    const mixed = await createPlan(d,h,[step, { ...step, step_id: "usd", payload: { quote_id: usdQuote } }]);
    expect(mixed).toMatchObject({ status:"ready",gross_commitment_minor:"18000" });
    const mixedApproval = await approve(d,client,h,mixed.plan_id,{ceiling:"18000"});
    expect(mixedApproval.ok).toBe(true);
    const snapshots = (await client.query("select conversion_evidence from approvals where id=$1",[mixedApproval.approval_id])).rows[0].conversion_evidence;
    expect(snapshots.map((row: { cost_conversion: { gross: { original_currency: string } } }) => row.cost_conversion.gross.original_currency)).toEqual(["EUR","USD"]);
    await client.query("update quotes set currency='USD' where id=$1",[quoteId]);
    expect(await createPlan(d,h,[step])).toMatchObject({ status:"ready",gross_commitment_minor:"6000" });
  });
});
