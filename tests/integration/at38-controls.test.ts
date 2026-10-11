import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { executeApprovedPlan } from "@/lib/actions/plans";
import { requestOutreach } from "@/lib/actions/outreach";
import {
  approve,
  connect,
  countingAdapter,
  createPlan,
  deps,
  FakeClock,
  seedHarbor,
  type Harbor,
} from "./actions.harness";

vi.mock("server-only", () => ({}));

const client = connect();
let harbor: Harbor;

function configureLocalSupabase(): void {
  const output = execFileSync("pnpm", ["exec", "supabase", "status", "-o", "env"], {
    encoding: "utf8",
  });
  const values = Object.fromEntries(
    output
      .split(/\r?\n/)
      .map((line) => line.match(/^([A-Z_]+)="?(.*?)"?$/))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .map((match) => [match[1], match[2]]),
  );
  process.env.SUPABASE_URL = values.API_URL ?? values.SUPABASE_URL;
  process.env.SUPABASE_PUBLISHABLE_KEY = values.ANON_KEY ?? values.SUPABASE_PUBLISHABLE_KEY;
  process.env.SUPABASE_SECRET_KEY = values.SERVICE_ROLE_KEY ?? values.SUPABASE_SECRET_KEY;
  process.env.APP_ENV = "replay";
}

async function addGmailConnection(h: Harbor): Promise<string> {
  await client.query(
    `insert into private.integration_credentials
      (org_id, connection_id, encrypted_credential_material, key_version)
     values ($1, $2, decode('010203', 'hex'), 'v1')`,
    [h.orgId, h.gmailConnectionId],
  );
  return h.gmailConnectionId;
}

async function prepareEmail(h: Harbor): Promise<string> {
  const result = await requestOutreach(deps(client, new FakeClock()), {
    orgId: h.orgId,
    caseId: h.caseId,
    userId: h.operatorId,
    idempotencyKey: randomUUID(),
    body: {
      contact_id: h.contactId,
      channel: "email",
      message: { subject: "AT-38 check", body: "Please confirm delivery." },
    },
  });
  if (!result.ok || result.result !== "prepared_action") throw new Error("Email action was not prepared");
  return result.action.id;
}

async function claim(h: Harbor, actionId: string): Promise<Record<string, unknown>> {
  const { rows } = await client.query(
    "select public.ledger_claim_dispatch($1, $2, 300, $3::timestamptz) as result",
    [h.orgId, actionId, "2026-10-12T15:00:00.000Z"],
  );
  return rows[0].result as Record<string, unknown>;
}

describe("AT-38 disconnect and evidence retention controls", () => {
  beforeAll(async () => {
    configureLocalSupabase();
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

  it("disconnects Gmail, removes credentials, and blocks prepared email claims", async () => {
    await client.query(
      "update public.organizations set environment_mode = 'sandbox' where id = $1",
      [harbor.orgId],
    );
    const connectionId = await addGmailConnection(harbor);
    const actionId = await prepareEmail(harbor);
    await client.query(
      "select public.ui_disconnect_connection($1::jsonb)",
      [JSON.stringify({ org_id: harbor.orgId, actor_user_id: harbor.ownerId })],
    );

    await expect(claim(harbor, actionId)).resolves.toMatchObject({
      ok: false,
      code: "failed_precondition",
      reason: "connection_unavailable",
    });
    const connection = await client.query(
      "select status from public.connections where id = $1 and org_id = $2",
      [connectionId, harbor.orgId],
    );
    const credentials = await client.query(
      "select count(*)::int as count from private.integration_credentials where connection_id = $1",
      [connectionId],
    );
    const audit = await client.query(
      `select count(*)::int as count
       from public.audit_events
       where org_id = $1 and entity_id = $2 and event_name = 'connection.gmail.disconnected'`,
      [harbor.orgId, connectionId],
    );
    expect(connection.rows[0].status).toBe("disconnected");
    expect(credentials.rows[0].count).toBe(0);
    expect(audit.rows[0].count).toBe(1);
  });

  it("allows replay email claims without Gmail while blocking sandbox claims", async () => {
    await client.query(
      "update public.connections set status = 'disconnected' where org_id = $1 and provider = 'gmail'",
      [harbor.orgId],
    );
    const replayActionId = await prepareEmail(harbor);
    await expect(claim(harbor, replayActionId)).resolves.toMatchObject({ ok: true });

    const sandboxHarbor = await seedHarbor(client, { mode: "sandbox" });
    await client.query(
      "update public.connections set status = 'disconnected' where org_id = $1 and provider = 'gmail'",
      [sandboxHarbor.orgId],
    );
    const sandboxActionId = await prepareEmail(sandboxHarbor);
    await expect(claim(sandboxHarbor, sandboxActionId)).resolves.toMatchObject({
      ok: false,
      code: "failed_precondition",
      reason: "connection_unavailable",
    });
  });

  it("blocks dispatch after the action preparer is deactivated", async () => {
    await addGmailConnection(harbor);
    const actionId = await prepareEmail(harbor);
    await client.query(
      "update public.memberships set active = false where org_id = $1 and auth_user_id = $2",
      [harbor.orgId, harbor.operatorId],
    );
    await expect(claim(harbor, actionId)).resolves.toMatchObject({
      ok: false,
      code: "failed_precondition",
      reason: "preparer_revoked",
    });
  });

  it("tombstones expired evidence while linked plans and actions remain", async () => {
    const actionAdapter = countingAdapter("demo_ledger_amendment");
    const d = deps(client, new FakeClock(), [actionAdapter.adapter]);
    const plan = await createPlan(d, harbor);
    const approval = await approve(d, client, harbor, plan.plan_id);
    const run = await executeApprovedPlan(d, {
      orgId: harbor.orgId,
      planId: plan.plan_id,
      approvalId: approval.approval_id,
    });
    expect(run.status).toBe("dispatch");
    if (run.status !== "dispatch" || !("action" in run.report)) throw new Error("Expected a plan action");
    const actionId = run.report.action.id;

    await client.query(
      `update public.evidence
       set retention_until = '2026-10-12T14:59:59Z',
           private_object_path = $2,
           supported_excerpt = 'Retained summary'
       where id = $1 and org_id = $3`,
      [harbor.evidenceId, `${harbor.orgId}/retained/source.eml`, harbor.orgId],
    );
    await client.query(
      `insert into public.case_evidence (org_id, case_id, evidence_id, purpose)
       values ($1, $2, $3, 'quote')`,
      [harbor.orgId, harbor.caseId, harbor.evidenceId],
    );
    const expired = await client.query(
      "select storage_path from public.expire_evidence_sources($1::timestamptz)",
      ["2026-10-12T15:00:00Z"],
    );
    const row = await client.query(
      "select private_object_path, tombstoned_at, supported_excerpt from public.evidence where id = $1 and org_id = $2",
      [harbor.evidenceId, harbor.orgId],
    );
    const links = await client.query(
      "select count(*)::int as count from public.case_evidence where evidence_id = $1 and org_id = $2",
      [harbor.evidenceId, harbor.orgId],
    );
    const retained = await client.query(
      `select
        (select count(*)::int from public.recovery_plans where id = $1 and org_id = $2) as plans,
        (select count(*)::int from public.actions where id = $3 and org_id = $2) as actions`,
      [plan.plan_id, harbor.orgId, actionId],
    );
    const summary = await client.query(
      "select supported_excerpt from public.evidence where id = $1 and org_id = $2",
      [harbor.evidenceId, harbor.orgId],
    );
    expect(expired.rows).toEqual([{ storage_path: `${harbor.orgId}/retained/source.eml` }]);
    expect(row.rows[0]).toMatchObject({
      private_object_path: null,
      supported_excerpt: "Retained summary",
    });
    expect(row.rows[0].tombstoned_at).toBeTruthy();
    expect(links.rows[0].count).toBe(1);
    expect(retained.rows[0]).toEqual({ plans: 1, actions: 1 });
    expect(summary.rows[0].supported_excerpt).toBe("Retained summary");
  });

  it("denies direct disconnect RPC execution to non-service roles", async () => {
    const { rows } = await client.query(
      `select has_function_privilege('anon', 'public.ui_disconnect_connection(jsonb)', 'execute') as anon,
              has_function_privilege('authenticated', 'public.ui_disconnect_connection(jsonb)', 'execute') as authenticated,
              has_function_privilege('service_role', 'public.ui_disconnect_connection(jsonb)', 'execute') as service_role,
              has_function_privilege('anon', 'public.expire_evidence_sources(timestamptz)', 'execute') as expire_anon,
              has_function_privilege('authenticated', 'public.expire_evidence_sources(timestamptz)', 'execute') as expire_authenticated,
              has_function_privilege('service_role', 'public.expire_evidence_sources(timestamptz)', 'execute') as expire_service_role`,
    );
    expect(rows[0]).toEqual({
      anon: false,
      authenticated: false,
      service_role: true,
      expire_anon: false,
      expire_authenticated: false,
      expire_service_role: true,
    });
  });
});
