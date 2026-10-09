import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import {
  fixture.orgId,
  fixture.itemCartonId,
  fixture.locationId,
  seedInboxData,
  cleanupMessages,
  resetPoSchedules,
  pgClient,
  pgRpcClient,
  now,
  type InboxFixture,
} from "./inbox-helpers";
import {
  ensureInboxConnection,
  ingestMessage,
} from "@/lib/db/messages";
import {
  processSourceMessage,
  resolveMessageMatch,
} from "@/lib/db/cases-open";
import { ingestReplayMessages } from "@/lib/integrations/gmail/replay";
import { toPublishedEvent } from "@/lib/workflows/outbox";

const MESSAGES_DIR = "tests/fixtures/harbor-pack/messages";

let client: Client;
let fixture: InboxFixture;
const rpc = () => pgRpcClient(client);
const deps = { mode: "replay" as const };

async function ingestFile(filename: string, historical = false) {
  const connectionId = await ensureInboxConnection(rpc(), fixture.orgId, "replay_inbox");
  const raw = readFileSync(join(MESSAGES_DIR, filename));
  return ingestMessage({
    rpc: rpc(),
    orgId: fixture.orgId,
    connectionId,
    providerMessageId: `replay:${filename}`,
    raw,
    historical,
    direction: "inbound",
  });
}

beforeAll(async () => {
  client = pgClient();
  await client.connect();
  // Dedicated org per file: nothing pre-existing to clean.
  fixture = await seedInboxData(client);
});

afterAll(async () => {
  await cleanupMessages(client, fixture.orgId);
  await fixture.cleanup();
  await client.end();
});

describe("AT-03 dedupe and idempotent processing", () => {
  it("AT-03 ingests the same raw message once; processing is idempotent", async () => {
    const first = await ingestFile("delay-po-1042.eml");
    const second = await ingestFile("delay-po-1042.eml");
    expect(second.source_message_id).toBe(first.source_message_id);
    expect(second.created).toBe(false);

    const msgs = await client.query(
      `select count(*) from public.source_messages
       where org_id = $1 and provider_message_id = 'replay:delay-po-1042.eml'`,
      [fixture.orgId],
    );
    expect(Number(msgs.rows[0].count)).toBe(1);
    const outbox = await client.query(
      `select count(*) from public.event_outbox
       where org_id = $1 and event_type = 'supplier.message.received'
         and aggregate_id = $2`,
      [fixture.orgId, first.source_message_id],
    );
    expect(Number(outbox.rows[0].count)).toBe(1);

    const r1 = await processSourceMessage({
      rpc: rpc(),
      orgId: fixture.orgId,
      sourceMessageId: first.source_message_id,
      mode: "auto",
      deps,
      now,
    });
    expect(r1.status).toBe("matched");
    expect(r1.replayed).toBe(false);

    const r2 = await processSourceMessage({
      rpc: rpc(),
      orgId: fixture.orgId,
      sourceMessageId: first.source_message_id,
      mode: "auto",
      deps,
      now,
    });
    expect(r2.replayed).toBe(true);
    expect(r2.case_ids).toEqual(r1.case_ids);

    const commits = await client.query(
      `select count(*) from public.commitment_events where org_id = $1`,
      [fixture.orgId],
    );
    expect(Number(commits.rows[0].count)).toBe(1);
    const cases = await client.query(
      `select count(*) from public.cases c
       join public.case_order_lines col on col.case_id = c.id and col.org_id = c.org_id
       where c.org_id = $1 and col.triggering_message_id = $2`,
      [fixture.orgId, first.source_message_id],
    );
    expect(Number(cases.rows[0].count)).toBe(1);
    const assessments = await client.query(
      `select event_id, org_id, aggregate_id, correlation_id, causation_id,
              event_type, schema_version, payload, created_at, attempts
       from public.event_outbox
       where org_id = $1 and event_type = 'case.assessment.requested'`,
      [fixture.orgId],
    );
    expect(assessments.rows).toHaveLength(1);
    // Bare payload: toPublishedEvent adds the envelope fields at publish time.
    expect(assessments.rows[0].payload).toEqual({
      case_id: r1.case_ids[0],
      source_version: expect.any(Number),
    });

    // The published event shape toPublishedEvent produces.
    const received = await client.query(
      `select event_id, org_id, aggregate_id, correlation_id, causation_id,
              event_type, schema_version, payload, created_at, attempts
       from public.event_outbox
       where org_id = $1 and event_type = 'supplier.message.received'`,
      [fixture.orgId],
    );
    expect(received.rows).toHaveLength(1);
    const published = toPublishedEvent(received.rows[0]);
    expect(published.data.message_id).toBe(first.source_message_id);
    expect(published.data.org_id).toBe(fixture.orgId);
    expect(published.id).toBe(received.rows[0].event_id);

    // Exactly one extraction was recorded across both processing attempts.
    const extractions = await client.query(
      `select count(*) from public.message_extractions
       where org_id = $1 and source_message_id = $2`,
      [fixture.orgId, first.source_message_id],
    );
    expect(Number(extractions.rows[0].count)).toBe(1);
  });
});

describe("AT-04 multi-line partial delay", () => {
  it("AT-04 applies split and date-only bounds to the right lines only", async () => {
    await resetPoSchedules(client, fixture);
    const { source_message_id: mid } = await ingestFile(
      "inbox-multi-line-partial.eml",
    );
    const r = await processSourceMessage({
      rpc: rpc(),
      orgId: fixture.orgId,
      sourceMessageId: mid,
      mode: "auto",
      deps,
      now,
    });
    expect(r.status).toBe("matched");
    expect(r.case_ids).toHaveLength(2);

    // PO-1042: original superseded, remainder 3,800 @ Oct 13, delayed 200 @ Oct 16 08:00 PDT
    const s1042 = await client.query(
      `select promise_state, quantity_remaining, earliest_at, latest_at
       from public.receipt_schedules
       where org_id = $1 and po_line_id = $2 order by created_at`,
      [fixture.orgId, fixture.po1042LineId],
    );
    const active1042 = s1042.rows.filter(
      (row) => row.promise_state !== "superseded",
    );
    expect(active1042).toHaveLength(2);
    const remainder = active1042.find((row) => row.quantity_remaining === 3800);
    expect(remainder).toBeTruthy();
    expect(new Date(remainder.earliest_at).toISOString()).toBe(
      "2026-10-13T15:00:00.000Z",
    );
    const delayed = active1042.find((row) => row.quantity_remaining === 200);
    expect(delayed).toBeTruthy();
    expect(new Date(delayed.earliest_at).toISOString()).toBe(
      "2026-10-16T15:00:00.000Z",
    );

    // PO-1043: 1,000 rolls moved to Oct 19, date-only bounds
    const s1043 = await client.query(
      `select promise_state, quantity_remaining, earliest_at, latest_at
       from public.receipt_schedules
       where org_id = $1 and po_line_id = $2 and promise_state <> 'superseded'`,
      [fixture.orgId, fixture.po1043LineId],
    );
    expect(s1043.rows).toHaveLength(1);
    expect(s1043.rows[0].quantity_remaining).toBe(1000);
    expect(new Date(s1043.rows[0].earliest_at).toISOString()).toBe(
      "2026-10-19T07:00:00.000Z",
    );
    expect(new Date(s1043.rows[0].latest_at).toISOString()).toBe(
      "2026-10-20T06:59:59.999Z",
    );

    // two linked cases, both triggered by the message
    const links = await client.query(
      `select case_id, po_line_id from public.case_order_lines
       where org_id = $1 and triggering_message_id = $2 order by po_line_id`,
      [fixture.orgId, mid],
    );
    expect(links.rows).toHaveLength(2);
    expect(new Set(links.rows.map((l) => l.case_id)).size).toBe(2);

    // PO-1044 untouched
    const s1044 = await client.query(
      `select promise_state, quantity_remaining from public.receipt_schedules
       where org_id = $1 and po_line_id = $2`,
      [fixture.orgId, fixture.po1044LineId],
    );
    expect(s1044.rows).toHaveLength(1);
    expect(s1044.rows[0].promise_state).toBe("confirmed");
    expect(s1044.rows[0].quantity_remaining).toBe(500);

    // commitment events: split + delay on 1042, delay on 1043
    const events = await client.query(
      `select kind from public.commitment_events
       where org_id = $1 and po_line_id = any($2::uuid[]) order by kind`,
      [fixture.orgId, [fixture.po1042LineId, fixture.po1043LineId]],
    );
    expect(events.rows.map((r) => r.kind).sort()).toEqual([
      "delay",
      "delay",
      "split",
    ]);

    // Every new schedule carries the dataset_id/external_id of the schedule
    // it supersedes so projections and re-imports keep linking it.
    const derived = await client.query(
      `select n.dataset_id, n.external_id, o.dataset_id as old_dataset_id,
              o.external_id as old_external_id
       from public.receipt_schedules n
       join public.receipt_schedules o on o.id = n.supersedes_id
       where n.org_id = $1 and n.po_line_id = any($2::uuid[])`,
      [fixture.orgId, [fixture.po1042LineId, fixture.po1043LineId]],
    );
    expect(derived.rows.length).toBe(3);
    for (const row of derived.rows) {
      expect(row.dataset_id).toBe(row.old_dataset_id);
      expect(row.external_id).toBe(row.old_external_id);
      expect(row.dataset_id).toBe(fixture.datasetId);
    }

    // The projection engine sees the delayed carton schedule in the active
    // dataset (superseded rows are filtered out).
    const facts = await client.query(
      `select public.load_projection_facts($1, $2, $3) as facts`,
      [fixture.orgId, fixture.itemCartonId, fixture.locationId],
    );
    const receipts = (facts.rows[0].facts as {
      receipts: { quantity_remaining: number; earliest_at: string }[];
    }).receipts;
    const delayedReceipt = receipts.find((r) => r.quantity_remaining === 200);
    expect(delayedReceipt).toBeTruthy();
    expect(new Date(delayedReceipt!.earliest_at).toISOString()).toBe(
      "2026-10-16T15:00:00.000Z",
    );
    expect(receipts.every((r) => r.quantity_remaining !== 4000)).toBe(true);

    // Bare payloads only: {case_id, source_version} with no envelope keys.
    const outbox = await client.query(
      `select event_id, aggregate_id, payload from public.event_outbox
       where org_id = $1 and event_type = 'case.assessment.requested'`,
      [fixture.orgId],
    );
    for (const row of outbox.rows) {
      expect(Object.keys(row.payload).sort()).toEqual([
        "case_id",
        "source_version",
      ]);
      expect(row.payload.case_id).toBe(row.aggregate_id);
    }
  });
});

describe("AT-05 ambiguous match review and resolution", () => {
  it("AT-05 opens a review with candidates; resolution applies correction", async () => {
    // Earlier tests mutated PO schedules; restore the canonical state.
    await resetPoSchedules(client, fixture);
    const testStart = new Date().toISOString();
    const { source_message_id: mid } = await ingestFile(
      "inbox-ambiguous-friday.eml",
    );
    const r = await processSourceMessage({
      rpc: rpc(),
      orgId: fixture.orgId,
      sourceMessageId: mid,
      mode: "auto",
      deps,
      now,
    });
    expect(r.status).toBe("needs_review");
    expect(r.review_id).toBeTruthy();

    const review = await client.query(
      `select status, candidates, unresolved, case_ids from public.message_match_reviews
       where id = $1`,
      [r.review_id],
    );
    expect(review.rows[0].status).toBe("open");
    const candIds = (review.rows[0].candidates as { po_line_id: string }[]).map(
      (c) => c.po_line_id,
    );
    // item_ref "carton" doesn't narrow; candidates fall back to the
    // supplier's open lines, which include the ambiguity twins.
    expect(candIds).toContain(fixture.po1042LineId);
    expect(candIds).toContain(fixture.po1044LineId);
    const fields = (review.rows[0].unresolved as { field: string }[]).map(
      (u) => u.field,
    );
    expect(fields).toContain("order_line");
    expect(fields).toContain("new_promise.date");

    // no schedule change, no commitment events, no assessment outbox
    const s = await client.query(
      `select count(*) from public.receipt_schedules
       where org_id = $1 and promise_state = 'superseded'
         and po_line_id = any($2::uuid[])`,
      [fixture.orgId, [fixture.po1042LineId, fixture.po1043LineId, fixture.po1044LineId]],
    );
    expect(Number(s.rows[0].count)).toBe(0);
    const caseRow = await client.query(
      `select phase, row_version from public.cases where id = $1`,
      [r.case_ids[0]],
    );
    expect(caseRow.rows[0].phase).toBe("needs_review");
    const expectedVersion = caseRow.rows[0].row_version;

    // stale expected_version -> 409
    await expect(
      resolveMessageMatch({
        rpc: rpc(),
        orgId: fixture.orgId,
        caseId: r.case_ids[0],
        actorUserId: null as unknown as string,
        input: {
          expected_version: expectedVersion + 5,
          selections: [{ line_index: 0, po_line_id: fixture.po1042LineId }],
          corrections: [],
          dismiss: false,
          reason: "operator reviewed",
        },
        deps,
        now,
      }),
    ).rejects.toMatchObject({ status: 409 });

    // correction quote not in source -> 422
    await expect(
      resolveMessageMatch({
        rpc: rpc(),
        orgId: fixture.orgId,
        caseId: r.case_ids[0],
        actorUserId: null as unknown as string,
        input: {
          expected_version: expectedVersion,
          selections: [{ line_index: 0, po_line_id: fixture.po1042LineId }],
          corrections: [
            {
              line_index: 0,
              field: "new_promise" as const,
              value: {
                local_date: "2026-10-16",
                local_time: "08:00",
                promise_state: "confirmed",
              },
              source: { quote: "never appears anywhere in the email" },
            },
          ],
          dismiss: false,
          reason: "operator reviewed",
        },
        deps,
        now,
      }),
    ).rejects.toMatchObject({ status: 422 });

    // valid resolution: pin PO-1042 + sourced new_promise correction
    const resolved = await resolveMessageMatch({
      rpc: rpc(),
      orgId: fixture.orgId,
      caseId: r.case_ids[0],
      actorUserId: null as unknown as string,
      input: {
        expected_version: expectedVersion,
        selections: [{ line_index: 0, po_line_id: fixture.po1042LineId }],
        corrections: [
          {
            line_index: 0,
            field: "new_promise" as const,
            value: {
              local_date: "2026-10-16",
              local_time: "08:00",
              promise_state: "confirmed",
            },
            source: { quote: "Friday, October 16" },
          },
        ],
        dismiss: false,
        reason: "operator confirmed date from email",
      },
      deps,
      now,
    });
    expect(resolved.status).toBe("matched");

    const extractions = await client.query(
      `select version, extractor from public.message_extractions
       where org_id = $1 and source_message_id = $2 order by version`,
      [fixture.orgId, mid],
    );
    expect(extractions.rows).toHaveLength(2);
    expect(extractions.rows[0].extractor).toBe("replay_fixture");
    expect(extractions.rows[1].extractor).toBe("operator_correction");

    const s1042 = await client.query(
      `select quantity_remaining, earliest_at from public.receipt_schedules
       where org_id = $1 and po_line_id = $2 and promise_state <> 'superseded'`,
      [fixture.orgId, fixture.po1042LineId],
    );
    expect(s1042.rows).toHaveLength(1);
    expect(new Date(s1042.rows[0].earliest_at).toISOString()).toBe(
      "2026-10-16T15:00:00.000Z",
    );

    const outbox = await client.query(
      `select count(*) from public.event_outbox
       where org_id = $1 and event_type = 'case.assessment.requested'
         and aggregate_id = $2 and created_at >= $3`,
      [fixture.orgId, resolved.case_ids[0], testStart],
    );
    expect(Number(outbox.rows[0].count)).toBe(1);

    const reviewAfter = await client.query(
      `select status from public.message_match_reviews where id = $1`,
      [r.review_id],
    );
    expect(reviewAfter.rows[0].status).toBe("resolved");
  });
});

describe("AT-20 integration: dedupe and cursor CAS", () => {
  it("AT-20 inbox_store_message dedupes and gmail_advance_cursor is CAS", async () => {
    const connId = await ensureInboxConnection(rpc(), fixture.orgId, "replay_inbox");
    // a gmail connection for the cursor test
    const cred = await rpc().rpc<{ connection_id: string }>(
      "gmail_store_connection",
      {
        org_id: fixture.orgId,
        actor_user_id: null,
        external_account_id: "acct-1",
        scopes: [],
        encrypted_b64: Buffer.from("x").toString("base64"),
        key_version: "v1",
        expires_at: null,
      },
    );

    // wrong expected cursor -> no advance
    const noAdvance = await rpc().rpc<{ advanced: boolean }>(
      "gmail_advance_cursor",
      {
        org_id: fixture.orgId,
        connection_id: cred.connection_id,
        expected_cursor: "wrong",
        new_cursor: "H5",
      },
    );
    expect(noAdvance.advanced).toBe(false);
    const okAdvance = await rpc().rpc<{ advanced: boolean }>(
      "gmail_advance_cursor",
      {
        org_id: fixture.orgId,
        connection_id: cred.connection_id,
        expected_cursor: null,
        new_cursor: "H5",
      },
    );
    expect(okAdvance.advanced).toBe(true);

    const raw = readFileSync(join(MESSAGES_DIR, "delay-po-1042.eml"));
    const first = await ingestMessage({
      rpc: rpc(),
      orgId: fixture.orgId,
      connectionId: connId,
      providerMessageId: "dedupe-test-1",
      raw,
      historical: true,
      direction: "inbound",
    });
    const second = await ingestMessage({
      rpc: rpc(),
      orgId: fixture.orgId,
      connectionId: connId,
      providerMessageId: "dedupe-test-1",
      raw,
      historical: true,
      direction: "inbound",
    });
    expect(second.created).toBe(false);
    expect(second.source_message_id).toBe(first.source_message_id);
  });
});

describe("AT-22 integration: connection status lifecycle", () => {
  it("AT-22 revoked/expired persist on the connection row", async () => {
    const cred = await rpc().rpc<{ connection_id: string }>(
      "gmail_store_connection",
      {
        org_id: fixture.orgId,
        actor_user_id: null,
        external_account_id: "acct-22",
        scopes: ["a"],
        encrypted_b64: Buffer.from("x").toString("base64"),
        key_version: "v1",
        expires_at: null,
      },
    );
    await rpc().rpc("gmail_set_status", {
      org_id: fixture.orgId,
      connection_id: cred.connection_id,
      status: "revoked",
      error_code: "invalid_grant",
    });
    const loaded = await rpc().rpc<{ status: string; sync_cursor: string | null }>(
      "gmail_load_credential",
      { org_id: fixture.orgId, connection_id: cred.connection_id },
    );
    expect(loaded.status).toBe("revoked");
    // existing stored messages are retained
    const connId = await ensureInboxConnection(rpc(), fixture.orgId, "replay_inbox");
    const raw = readFileSync(join(MESSAGES_DIR, "delay-po-1042.eml"));
    const stored = await ingestMessage({
      rpc: rpc(),
      orgId: fixture.orgId,
      connectionId: connId,
      providerMessageId: "retain-1",
      raw,
      historical: true,
      direction: "inbound",
    });
    const found = await client.query(
      `select count(*) from public.source_messages where id = $1`,
      [stored.source_message_id],
    );
    expect(Number(found.rows[0].count)).toBe(1);
    void cred;
  });
});

describe("AT-31 prompt injection containment", () => {
  it("AT-31 spoofed sender stays needs_review with no outreach or changes", async () => {
    const countBefore = (
      await client.query(
        `select count(*) from public.receipt_schedules
         where org_id = $1 and promise_state = 'superseded'`,
        [fixture.orgId],
      )
    ).rows[0].count;
    const casesBefore = await client.query(
      `select id, row_version from public.cases where org_id = $1 order by id`,
      [fixture.orgId],
    );
    const { source_message_id: mid } = await ingestFile(
      "inbox-prompt-injection.eml",
    );
    const r = await processSourceMessage({
      rpc: rpc(),
      orgId: fixture.orgId,
      sourceMessageId: mid,
      mode: "auto",
      deps,
      now,
    });
    expect(r.status).toBe("needs_review");
    expect(r.case_ids).toHaveLength(0);
    const review = await client.query(
      `select unresolved, candidates from public.message_match_reviews where id = $1`,
      [r.review_id],
    );
    expect(
      (review.rows[0].unresolved as { field: string }[]).some(
        (u) => u.field === "supplier",
      ),
    ).toBe(true);
    expect(review.rows[0].candidates).toHaveLength(0);
    // No case created or touched.
    const casesAfter = await client.query(
      `select id, row_version from public.cases where org_id = $1 order by id`,
      [fixture.orgId],
    );
    expect(casesAfter.rows).toEqual(casesBefore.rows);
    // no schedule changes, no outbound action rows, no contact change
    const supersededBefore = await client.query(
      `select count(*) from public.receipt_schedules
       where org_id = $1 and promise_state = 'superseded'`,
      [fixture.orgId],
    );
    expect(supersededBefore.rows[0].count).toBe(countBefore);
    const actions = await client.query(
      `select count(*) from public.actions where org_id = $1`,
      [fixture.orgId],
    );
    expect(Number(actions.rows[0].count)).toBe(0);
    const contacts = await client.query(
      `select count(*) from public.supplier_contacts
       where org_id = $1 and normalized_address like '%evil.example'`,
      [fixture.orgId],
    );
    expect(Number(contacts.rows[0].count)).toBe(0);
    void mid;
  });
});

describe("replay inbox ingestion", () => {
  it("ingests all .eml fixtures through the shared ingestMessage path", async () => {
    const connId = await ensureInboxConnection(rpc(), fixture.orgId, "replay_inbox");
    const results = await ingestReplayMessages({
      rpc: rpc(),
      orgId: fixture.orgId,
      connectionId: connId,
      files: ["inbox-html-only.eml"],
    });
    expect(results).toHaveLength(1);
    expect(results[0].created).toBe(true);
    const content = await client.query(
      `select content from private.source_message_content
       where source_message_id = $1 and segment_kind = 'body'`,
      [results[0].source_message_id],
    );
    expect(content.rows[0].content).not.toContain("script");
    expect(content.rows[0].content).toContain("PO-1042");
  });
});
