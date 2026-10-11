import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connect, seedHarbor, type Harbor } from "./actions.harness";

const client = connect();
let harbor: Harbor;

async function requestReassessment(input: {
  org_id: string;
  case_id: string;
  action_id: string;
  source_event_id: string;
  outcome: string;
}): Promise<{ status: string }> {
  const { rows } = await client.query(
    "select public.request_reassess_after_call($1::jsonb) as result",
    [JSON.stringify(input)],
  );
  return rows[0].result as { status: string };
}

describe("request_reassess_after_call", () => {
  beforeAll(async () => {
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
  });
  beforeEach(async () => {
    await client.query("begin");
    harbor = await seedHarbor(client);
  });
  afterEach(async () => {
    await client.query("rollback");
  });

  it("requests once and deduplicates retries by source event id", async () => {
    const eventId = crypto.randomUUID();
    const input = {
      org_id: harbor.orgId,
      case_id: harbor.caseId,
      action_id: crypto.randomUUID(),
      source_event_id: eventId,
      outcome: "answered_with_offer",
    };

    await expect(requestReassessment(input)).resolves.toEqual({ status: "requested" });
    await expect(requestReassessment(input)).resolves.toEqual({ status: "duplicate" });

    const outbox = await client.query(
      `select count(*)::int as count from public.event_outbox
        where org_id = $1 and correlation_id = $2 and event_type = 'case.assessment.requested'`,
      [harbor.orgId, eventId],
    );
    const audit = await client.query(
      "select count(*)::int as count from public.audit_events where org_id = $1 and request_id = $2",
      [harbor.orgId, eventId],
    );
    const row = await client.query(
      "select actor_type, actor_id, reason from public.audit_events where org_id = $1 and request_id = $2",
      [harbor.orgId, eventId],
    );
    expect(outbox.rows[0].count).toBe(1);
    expect(audit.rows[0].count).toBe(1);
    expect(row.rows[0]).toEqual({
      actor_type: "system",
      actor_id: "Conduit",
      reason: "supplier_offer_received",
    });
  });

  it("consumes a closed case event without creating an outbox row", async () => {
    const eventId = crypto.randomUUID();
    await client.query("update public.cases set phase = 'closed' where id = $1 and org_id = $2", [
      harbor.caseId,
      harbor.orgId,
    ]);
    await expect(requestReassessment({
      org_id: harbor.orgId,
      case_id: harbor.caseId,
      action_id: crypto.randomUUID(),
      source_event_id: eventId,
      outcome: "answered_with_offer",
    })).resolves.toEqual({ status: "skipped_closed" });
    const outbox = await client.query(
      "select count(*)::int as count from public.event_outbox where correlation_id = $1",
      [eventId],
    );
    expect(outbox.rows[0].count).toBe(0);
  });

  it("returns not_found for a case belonging to another organization", async () => {
    const other = await seedHarbor(client);
    await expect(requestReassessment({
      org_id: harbor.orgId,
      case_id: other.caseId,
      action_id: crypto.randomUUID(),
      source_event_id: crypto.randomUUID(),
      outcome: "answered_with_offer",
    })).resolves.toEqual({ status: "not_found" });
  });

  it("does not grant execute permission to anon or authenticated", async () => {
    const { rows } = await client.query(
      `select has_function_privilege('anon', 'public.request_reassess_after_call(jsonb)', 'execute') as anon,
              has_function_privilege('authenticated', 'public.request_reassess_after_call(jsonb)', 'execute') as authenticated,
              has_function_privilege('service_role', 'public.request_reassess_after_call(jsonb)', 'execute') as service_role`,
    );
    expect(rows[0]).toEqual({ anon: false, authenticated: false, service_role: true });
  });
});
