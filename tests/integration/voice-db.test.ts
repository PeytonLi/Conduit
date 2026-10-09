import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import { handleVoiceToolRequest } from "@/lib/integrations/elevenlabs/tools";
import type {
  ProvisionalOfferResult,
  VoiceGrantResolution,
  VoiceOfferContext,
  VoiceStore,
} from "@/lib/db/voice-store";

const org = "00000000-0000-4000-8000-000000000001";
let item: string;
let location: string;

const client = new Client({
  connectionString:
    process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
});

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const at = "2026-10-12T17:00:00.000Z";

let ids: { supplier: string; contact: string; caseId: string; action: string };

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  const result = await client.query(sql, params);
  return result.rows[0] as T;
}

async function seedCall() {
  ids = { supplier: randomUUID(), contact: randomUUID(), caseId: randomUUID(), action: randomUUID() };
  const po = randomUUID();
  item = randomUUID();
  location = randomUUID();
  await client.query("insert into public.items (id, org_id, sku, description, base_unit) values ($1, $2, $3, '12in shipping box', 'each')", [item, org, `BOX-${item.slice(0, 8)}`]);
  await client.query("insert into public.locations (id, org_id, name, timezone) values ($1, $2, 'Oakland DC', 'America/Los_Angeles')", [location, org]);
  const line = randomUUID();
  await client.query("insert into public.suppliers (id, org_id, name) values ($1, $2, 'Acme Corrugated')", [ids.supplier, org]);
  await client.query(
    `insert into public.supplier_contacts (id, org_id, supplier_id, channel, normalized_address, display_name, permitted_channels, outreach_approved_at)
     values ($1, $2, $3, 'phone', '+15555550100', 'Dana', '{phone}', now())`,
    [ids.contact, org, ids.supplier],
  );
  await client.query("insert into public.purchase_orders (id, org_id, external_id, supplier_id, currency) values ($1, $2, 'PO-VOICE-1', $3, 'USD')", [po, org, ids.supplier]);
  await client.query(
    `insert into public.purchase_order_lines (id, org_id, purchase_order_id, external_line_id, item_id, destination_location_id, ordered_qty, unit_price_minor)
     values ($1, $2, $3, '1', $4, $5, 1000, 120)`,
    [line, org, po, item, location],
  );
  await client.query("insert into public.cases (id, org_id, item_id, location_id, phase) values ($1, $2, $3, $4, 'awaiting_supplier')", [ids.caseId, org, item, location]);
  await client.query("insert into public.case_order_lines (org_id, case_id, po_line_id, affected_qty) values ($1, $2, $3, 400)", [org, ids.caseId, line]);
  await client.query(
    `insert into public.actions (id, org_id, case_id, kind, state, payload_hash, payload, idempotency_key, mode)
     values ($1, $2, $3, 'supplier_call', 'dispatching', 'h', '{}', $4, 'sandbox')`,
    [ids.action, org, ids.caseId, `call:${ids.action}`],
  );
}

async function prepare(token: string, actionId = ids.action) {
  return one<{ r: { status: string } }>(
    "select public.voice_prepare_call($1, $2, $3, $4, $5, $6, $7) as r",
    [org, actionId, ids.caseId, ids.contact, hash(token), ["read_case_facts", "record_provisional_offer"], "2026-10-12T17:15:00Z"],
  );
}

function createDatabaseVoiceStore(): VoiceStore {
  return {
    async resolveGrant(tokenHash: string) {
      return (await one<{ r: VoiceGrantResolution | null }>("select public.voice_resolve_grant($1) as r", [tokenHash])).r;
    },
    async offerContext(orgId: string, caseId: string, contactId: string) {
      return (await one<{ r: VoiceOfferContext | null }>(
        "select public.voice_offer_context($1, $2, $3) as r",
        [orgId, caseId, contactId],
      )).r;
    },
    async recordToolEvent(input: Parameters<VoiceStore["recordToolEvent"]>[0]) {
      await client.query(
        "select public.voice_record_tool_event($1, $2, $3, $4, $5, $6::jsonb, $7)",
        [
          input.orgId,
          input.caseId,
          input.actionId,
          input.tool,
          input.resultCode,
          JSON.stringify(input.payload),
          input.at.toISOString(),
        ],
      );
    },
    async recordProvisionalOffer(input: Parameters<VoiceStore["recordProvisionalOffer"]>[0]) {
      return (await one<{ r: ProvisionalOfferResult }>(
        "select public.voice_record_provisional_offer($1::jsonb) as r",
        [JSON.stringify(input)],
      )).r;
    },
  } as unknown as VoiceStore;
}

function callback(conversationId: string, actionHint: string | null, payloadHash = "p1") {
  return one<{ r: { status: string; receipt_id?: string } }>("select public.voice_record_callback($1::jsonb) as r", [
    JSON.stringify({
      provider: "elevenlabs",
      external_event_key: `post_call_transcription:${conversationId}`,
      conversation_id: conversationId,
      event_type: "post_call_transcription",
      payload_hash: payloadHash,
      payload: { type: "post_call_transcription" },
      received_at: at,
      action_hint: actionHint,
      excerpt: "summary",
      provider_call_id: "sip_1",
      duration_seconds: 90,
      outcome: { outcome: "answered_no_solution", provider_status: "done", transport_completed: true, procurement_result: "no_offer", detail: {} },
    }),
  ]);
}

describe("voice SQL functions", () => {
  beforeAll(async () => {
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
  });
  beforeEach(async () => {
    await client.query("begin");
    await seedCall();
  });
  afterEach(async () => {
    await client.query("rollback");
  });

  it("stores only a token hash and refuses a second attempt for the same action (AT-25)", async () => {
    expect((await prepare("tok-1")).r.status).toBe("prepared");
    expect((await prepare("tok-2")).r.status).toBe("already_attempted");
    const grants = await client.query("select token_hash from private.voice_grants where action_id = $1", [ids.action]);
    expect(grants.rows).toEqual([{ token_hash: hash("tok-1") }]);
    const context = await one<{ r: { existing_call_session: boolean; facts: { order_lines: { po_ref: string }[] } } }>(
      "select public.voice_call_context($1, $2, $3) as r",
      [org, ids.action, ids.contact],
    );
    expect(context.r.existing_call_session).toBe(true);
    expect(context.r.facts.order_lines.map((l) => l.po_ref)).toEqual(["PO-VOICE-1"]);
  });

  it("resolves the grant with live run_control (AT-14/AT-27)", async () => {
    await prepare("tok-1");
    await client.query("update public.cases set run_control = 'paused' where id = $1", [ids.caseId]);
    const grant = await one<{ r: { org_id: string; case_id: string; run_control: string } }>("select public.voice_resolve_grant($1) as r", [hash("tok-1")]);
    expect(grant.r).toMatchObject({ org_id: org, case_id: ids.caseId, run_control: "paused" });
    expect((await one<{ r: unknown }>("select public.voice_resolve_grant($1) as r", [hash("other")])).r).toBeNull();
  });

  it("client roles cannot execute voice functions or read grants (AT-14)", async () => {
    await prepare("tok-1");
    await client.query("savepoint s");
    await client.query("set local role authenticated");
    await expect(client.query("select public.voice_resolve_grant($1)", [hash("tok-1")])).rejects.toThrow(/permission denied/);
    await client.query("rollback to savepoint s");
  });

  it("records offers as provisional quotes with an owner task (AT-16)", async () => {
    await prepare("tok-1");
    const offer = await one<{ r: { quote_id: string; owner_task_id: string } }>("select public.voice_record_provisional_offer($1::jsonb) as r", [
      JSON.stringify({
        org_id: org, case_id: ids.caseId, action_id: ids.action, contact_id: ids.contact, conversation_id: "conv_1",
        recorded_at: at, content_hash: "c", excerpt: "Verbal supplier offer (unverified)", quantity: 400, unit: "each",
        unit_price_minor: "130", currency: "USD", freight_minor: "60000", fees_minor: "0", arrival_by: "2026-10-18T23:59:59Z",
        valid_until: null, order_cutoff: null, added_cost_minor: "64000", owner_task_kind: "above_ceiling", owner_task_reason: "above",
      }),
    ]);
    const quote = await one("select status, unit_price_minor::text, verified_at from public.quotes where id = $1", [offer.r.quote_id]);
    expect(quote).toEqual({ status: "provisional", unit_price_minor: "130", verified_at: null });
    const task = await one("select kind, status from public.voice_owner_tasks where id = $1", [offer.r.owner_task_id]);
    expect(task).toEqual({ kind: "above_ceiling", status: "open" });
    expect(await one("select phase::text, current_plan_id from public.cases where id = $1", [ids.caseId])).toEqual({ phase: "awaiting_supplier", current_plan_id: null });
  });

  it("reads the F5-shaped policy ceiling and raises a task only for an over-ceiling offer", async () => {
    const policyId = randomUUID();
    await client.query(
      `insert into public.policies (id, org_id, version, settings, reason)
       values ($1, $2, (select coalesce(max(version), 0) + 1 from public.policies where org_id = $2), $3::jsonb, 'voice integration test')`,
      [policyId, org, JSON.stringify({ negotiation: { ceiling_minor: "50000" } })],
    );
    await client.query("update public.organizations set current_policy_version_id = $1 where id = $2", [policyId, org]);

    await prepare("tok-ceiling");
    const context = await one<{ r: VoiceOfferContext }>(
      "select public.voice_offer_context($1, $2, $3) as r",
      [org, ids.caseId, ids.contact],
    );
    expect(context.r).toMatchObject({
      negotiation_ceiling_minor: "50000",
      timezone: "America/Los_Angeles",
    });

    const terms = {
      quantity: 400,
      currency: "USD",
      unit_price: "1.30",
      arrival_date: "2026-10-16",
      quote_valid_until: "2026-10-20",
      order_cutoff: "2026-10-15",
      split_delivery: false,
    };
    const store = createDatabaseVoiceStore();
    const deps = { store, now: () => new Date(at) };

    expect((await handleVoiceToolRequest("record_provisional_offer", "tok-ceiling", { ...terms, freight: "50.00" }, deps)).status).toBe(200);
    expect((await handleVoiceToolRequest("record_provisional_offer", "tok-ceiling", { ...terms, freight: "600.00" }, deps)).status).toBe(200);

    const tasks = await client.query("select kind from public.voice_owner_tasks where action_id = $1", [ids.action]);
    expect(tasks.rows).toEqual([{ kind: "above_ceiling" }]);
  });

  it("dedupes callbacks, links early ones by action hint, quarantines strangers (AT-40)", async () => {
    await prepare("tok-1");
    await client.query("update public.cases set run_control = 'paused' where id = $1", [ids.caseId]);
    const first = await callback("conv_early", ids.action);
    expect(first.r.status).toBe("recorded");
    const dup = await callback("conv_early", ids.action, "p2");
    expect(dup.r).toMatchObject({ status: "duplicate", receipt_id: first.r.receipt_id });
    expect(Number((await one<{ n: string }>("select count(*) n from public.callback_receipts where related_action_id = $1", [ids.action])).n)).toBe(1);
    expect(Number((await one<{ n: string }>("select count(*) n from public.event_outbox where correlation_id = $1 and event_type = 'supplier.call.finished'", [ids.action])).n)).toBe(1);
    expect(await one("select state::text from public.actions where id = $1", [ids.action])).toEqual({ state: "confirmed" });
    expect(await one("select provider_conversation_id, disposition from public.call_sessions where action_id = $1", [ids.action])).toEqual({ provider_conversation_id: "conv_early", disposition: "answered_no_solution" });
    expect(await one("select run_control::text from public.cases where id = $1", [ids.caseId])).toEqual({ run_control: "paused" });
    expect((await one<{ revoked_at: Date | null }>("select revoked_at from private.voice_grants where action_id = $1", [ids.action])).revoked_at).not.toBeNull();

    const casesBefore = (await one<{ n: string }>("select count(*) n from public.cases")).n;
    expect((await callback("conv_stranger", null)).r.status).toBe("quarantined");
    expect((await callback("conv_stranger", null)).r.status).toBe("quarantined");
    expect((await one<{ n: string }>("select count(*) n from public.cases")).n).toBe(casesBefore);
    expect(await one("select delivery_count from private.voice_callback_quarantine where conversation_id = 'conv_stranger'")).toEqual({ delivery_count: 2 });
  });

  it("flags overdue calls for reconciliation once, without redialing", async () => {
    await prepare("tok-1");
    await client.query("update public.call_sessions set created_at = '2026-10-12T16:00:00Z' where action_id = $1", [ids.action]);
    expect((await one<{ n: number }>("select public.voice_flag_stale_calls($1, 1200) n", [at])).n).toBeGreaterThanOrEqual(1);
    expect((await one<{ n: number }>("select public.voice_flag_stale_calls($1, 1200) n", [at])).n).toBe(0);
    const row = await one("select payload from public.event_outbox where correlation_id = $1 and event_type = 'action.reconcile.requested'", [ids.action]);
    expect(row).toEqual({ payload: { action_id: ids.action } });
  });
});
