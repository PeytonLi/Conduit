import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import {
  seedInboxData,
  cleanupMessages,
  pgClient,
  pgRpcClient,
  now,
  type InboxFixture,
} from "./inbox-helpers";
import { ensureInboxConnection, ingestMessage } from "@/lib/db/messages";
import { processSourceMessage } from "@/lib/db/cases-open";

const MESSAGES_DIR = "tests/fixtures/harbor-pack/messages";

let client: Client;
let fixture: InboxFixture;
const rpc = () => pgRpcClient(client);
const deps = { mode: "replay" as const };

async function ingestFile(filename: string, providerMessageId = `replay:${filename}`) {
  const connectionId = await ensureInboxConnection(rpc(), fixture.orgId, "replay_inbox");
  const raw = readFileSync(join(MESSAGES_DIR, filename));
  return ingestMessage({
    rpc: rpc(),
    orgId: fixture.orgId,
    connectionId,
    providerMessageId,
    raw,
    historical: false,
    direction: "inbound",
  });
}

// Response rows and the waits/cases seeded here aren't covered by the shared
// message cleanup; drop them per test so no stale pending wait can steal a
// later message's routing.
async function clearResponses() {
  await client.query("set session_replication_role = replica");
  const statements = [
    `delete from public.planner_waits where org_id = $1`,
    `delete from public.offers where org_id = $1`,
    `delete from public.quotes where org_id = $1`,
    `delete from public.case_evidence where org_id = $1 and purpose = 'supplier_response'`,
    `delete from public.evidence where org_id = $1 and source_type = 'email_reply'`,
    `delete from public.event_outbox where org_id = $1 and event_type = 'supplier.response.recorded'`,
    `delete from public.case_order_lines where org_id = $1`,
    `delete from public.actions where org_id = $1`,
    `delete from public.cases where org_id = $1`,
    `delete from public.audit_events where org_id = $1`,
  ];
  for (const sql of statements) await client.query(sql, [fixture.orgId]);
  await client.query("set session_replication_role = default");
}

interface WaitingCase {
  caseId: string;
  waitId: string;
}

/** A case awaiting a supplier response on the seeded Bay Carton PO-1042 line. */
async function seedWaitingCase(): Promise<WaitingCase> {
  const caseId = randomUUID();
  const actionId = randomUUID();
  const waitId = randomUUID();
  await client.query(
    `insert into public.cases (id, org_id, item_id, location_id, phase)
     values ($1, $2, $3, $4, 'awaiting_supplier')`,
    [caseId, fixture.orgId, fixture.itemCartonId, fixture.locationId],
  );
  await client.query(
    `insert into public.case_order_lines (org_id, case_id, po_line_id, affected_qty)
     values ($1, $2, $3, 4000)`,
    [fixture.orgId, caseId, fixture.po1042LineId],
  );
  await client.query(
    `insert into public.actions
       (id, org_id, case_id, kind, state, payload_hash, payload, idempotency_key, mode)
     values ($1, $2, $3, 'supplier_email', 'dispatching', 'h', $4, $5, 'sandbox')`,
    [
      actionId,
      fixture.orgId,
      caseId,
      JSON.stringify({ supplier_id: fixture.supplierId, contact_id: fixture.contactId }),
      `email:${actionId}`,
    ],
  );
  await client.query(
    `insert into public.planner_waits
       (id, org_id, case_id, episode, expected_kind, action_id, deadline_at, status, created_at)
     values ($1, $2, $3, 1, 'supplier_response', $4, '2026-10-12T16:00:00Z', 'pending', '2026-10-12T14:00:00Z')`,
    [waitId, fixture.orgId, caseId, actionId],
  );
  return { caseId, waitId };
}

const process = (sourceMessageId: string) =>
  processSourceMessage({
    rpc: rpc(),
    orgId: fixture.orgId,
    sourceMessageId,
    mode: "auto",
    deps,
    now,
  });

async function waitSatisfied(caseId: string, waitId: string): Promise<boolean> {
  const res = await client.query(
    `select exists(
       select 1 from public.case_evidence ce
       join public.evidence e on e.id = ce.evidence_id and e.org_id = ce.org_id
       where ce.org_id = $1 and ce.case_id = $2 and ce.purpose = 'supplier_response'
         and e.captured_at >= (select created_at from public.planner_waits where id = $3)
     ) as satisfied`,
    [fixture.orgId, caseId, waitId],
  );
  return res.rows[0].satisfied as boolean;
}

beforeAll(async () => {
  client = pgClient();
  await client.connect();
  fixture = await seedInboxData(client);
});

beforeEach(async () => {
  await clearResponses();
});

afterAll(async () => {
  await cleanupMessages(client, fixture.orgId);
  await clearResponses();
  await fixture.cleanup();
  await client.end();
});

describe("supplier email responses", () => {
  it("reply to a pending supplier_response wait records evidence, offer and provisional quote and emits supplier.response.recorded", async () => {
    const { caseId, waitId } = await seedWaitingCase();
    const ingested = await ingestFile("supplier-reply-offer.eml");
    const result = await process(ingested.source_message_id);

    expect(result.status).toBe("supplier_response");
    expect(result.replayed).toBe(false);
    expect(result.case_ids).toEqual([caseId]);

    const message = await client.query(
      `select processing_state from public.source_messages where id = $1`,
      [ingested.source_message_id],
    );
    expect(message.rows[0].processing_state).toBe("processed");

    const evidence = await client.query(
      `select e.* from public.evidence e
       join public.case_evidence ce on ce.evidence_id = e.id and ce.org_id = e.org_id
       where ce.org_id = $1 and ce.case_id = $2 and ce.purpose = 'supplier_response'`,
      [fixture.orgId, caseId],
    );
    expect(evidence.rowCount).toBe(1);
    expect(evidence.rows[0].source_type).toBe("email_reply");
    expect(evidence.rows[0].supported_excerpt).toContain("600 cartons");

    const offers = await client.query(
      `select * from public.offers where org_id = $1 and case_id = $2`,
      [fixture.orgId, caseId],
    );
    expect(offers.rowCount).toBe(1);
    expect(offers.rows[0].source_type).toBe("email");
    expect(offers.rows[0].supplier_id).toBe(fixture.supplierId);
    expect(offers.rows[0].contact_id).toBe(fixture.contactId);
    expect(offers.rows[0].evidence_ids).toEqual([evidence.rows[0].id]);
    // received_at is the message's sent_at (Oct 12 10:00 PDT = 17:00Z)
    expect(offers.rows[0].received_at.toISOString()).toBe("2026-10-12T17:00:00.000Z");

    const quotes = await client.query(
      `select * from public.quotes where org_id = $1 and offer_id = $2`,
      [fixture.orgId, offers.rows[0].id],
    );
    expect(quotes.rowCount).toBe(1);
    const quote = quotes.rows[0];
    expect(quote.status).toBe("provisional");
    expect(quote.item_id).toBe(fixture.itemCartonId);
    expect(quote.destination_location_id).toBe(fixture.locationId);
    expect(quote.quantity).toBe(600);
    expect(quote.unit).toBe("carton");
    expect(quote.freight_minor).toBe("7500");
    expect(quote.currency).toBe("USD");
    expect(quote.arrival_start.toISOString()).toBe("2026-10-14T07:00:00.000Z");
    expect(quote.arrival_end.toISOString()).toBe("2026-10-15T06:59:59.999Z");
    expect(quote.valid_until.toISOString()).toBe("2026-10-16T06:59:59.999Z");

    const events = await client.query(
      `select * from public.event_outbox
       where org_id = $1 and event_type = 'supplier.response.recorded'`,
      [fixture.orgId],
    );
    expect(events.rowCount).toBe(1);
    expect(events.rows[0].aggregate_id).toBe(caseId);
    expect(events.rows[0].payload).toEqual({
      case_id: caseId,
      evidence_id: evidence.rows[0].id,
    });

    expect(await waitSatisfied(caseId, waitId)).toBe(true);
  });

  it("reply with no offer terms still records the response evidence and offer, no quote", async () => {
    const { caseId, waitId } = await seedWaitingCase();
    const ingested = await ingestFile("supplier-reply-noterms.eml");
    const result = await process(ingested.source_message_id);

    expect(result.status).toBe("supplier_response");
    expect(result.case_ids).toEqual([caseId]);

    const offers = await client.query(
      `select id from public.offers where org_id = $1 and case_id = $2`,
      [fixture.orgId, caseId],
    );
    expect(offers.rowCount).toBe(1);
    const quotes = await client.query(
      `select count(*)::int as n from public.quotes where org_id = $1 and offer_id = $2`,
      [fixture.orgId, offers.rows[0].id],
    );
    expect(quotes.rows[0].n).toBe(0);
    expect(await waitSatisfied(caseId, waitId)).toBe(true);
  });

  it("two-part split offer on one PO line is recorded with two quotes and no match review", async () => {
    const { caseId } = await seedWaitingCase();
    const ingested = await ingestFile("supplier-reply-split.eml");
    const result = await process(ingested.source_message_id);

    expect(result.status).toBe("supplier_response");
    expect(result.case_ids).toEqual([caseId]);

    const reviews = await client.query(
      `select count(*)::int as n from public.message_match_reviews
       where org_id = $1 and source_message_id = $2`,
      [fixture.orgId, ingested.source_message_id],
    );
    expect(reviews.rows[0].n).toBe(0);

    const quotes = await client.query(
      `select q.quantity, q.arrival_end from public.quotes q
       join public.offers o on o.id = q.offer_id and o.org_id = q.org_id
       where q.org_id = $1 and o.case_id = $2
       order by q.arrival_end`,
      [fixture.orgId, caseId],
    );
    expect(quotes.rowCount).toBe(2);
    expect(quotes.rows.map((r) => r.quantity)).toEqual([600, 3400]);
  });

  it("reply from the same contact with no pending wait falls through to ignored", async () => {
    // No waiting case seeded.
    const ingested = await ingestFile(
      "supplier-reply-noterms.eml",
      "replay:supplier-reply-noterms-nowait",
    );
    const result = await process(ingested.source_message_id);

    expect(result.status).toBe("not_delay");
    const message = await client.query(
      `select processing_state from public.source_messages where id = $1`,
      [ingested.source_message_id],
    );
    expect(message.rows[0].processing_state).toBe("ignored");
    const evidence = await client.query(
      `select count(*)::int as n from public.evidence
       where org_id = $1 and source_type = 'email_reply'`,
      [fixture.orgId],
    );
    expect(evidence.rows[0].n).toBe(0);
  });

  it("reprocessing the same source_message replays without duplicating offer or quote", async () => {
    const { caseId } = await seedWaitingCase();
    const ingested = await ingestFile(
      "supplier-reply-offer.eml",
      "replay:supplier-reply-offer-reprocess",
    );
    const first = await process(ingested.source_message_id);
    expect(first.status).toBe("supplier_response");

    const second = await process(ingested.source_message_id);
    expect(second.status).toBe("supplier_response");
    expect(second.replayed).toBe(true);
    expect(second.case_ids).toEqual([caseId]);

    const offers = await client.query(
      `select count(*)::int as n from public.offers where org_id = $1 and case_id = $2`,
      [fixture.orgId, caseId],
    );
    expect(offers.rows[0].n).toBe(1);
    const quotes = await client.query(
      `select count(*)::int as n from public.quotes
       where org_id = $1 and offer_id in (select id from public.offers where org_id = $1 and case_id = $2)`,
      [fixture.orgId, caseId],
    );
    expect(quotes.rows[0].n).toBe(1);
    const evidence = await client.query(
      `select count(*)::int as n from public.evidence
       where org_id = $1 and source_type = 'email_reply'`,
      [fixture.orgId],
    );
    expect(evidence.rows[0].n).toBe(1);
  });
});
