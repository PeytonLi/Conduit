import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SupabasePlannerStore } from "@/lib/agent/store-supabase";
import { createInboxOrg, pgClient, type InboxOrg } from "./inbox-helpers";

vi.mock("server-only", () => ({}));

interface PlannerFixture extends InboxOrg {
  caseId: string;
  itemId: string;
  supplierId: string;
}

let database: Client | null = null;
let fixture: PlannerFixture | null = null;
let store: SupabasePlannerStore | null = null;

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
  const url = values.API_URL ?? values.SUPABASE_URL;
  const secretKey = values.SERVICE_ROLE_KEY ?? values.SUPABASE_SECRET_KEY;
  if (!url || !secretKey) throw new Error("Local Supabase service credentials are unavailable");
  process.env.SUPABASE_URL = url;
  process.env.SUPABASE_SECRET_KEY = secretKey;
  store = new SupabasePlannerStore(
    createClient(url, secretKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    }),
  );
}

beforeAll(async () => {
  configureLocalSupabase();
  const db = pgClient();
  database = db;
  await db.connect();
  const org = await createInboxOrg(db, `planner-store-${randomUUID().slice(0, 8)}`);
  const itemId = randomUUID();
  const supplierId = randomUUID();
  const caseId = randomUUID();
  await db.query(
    `insert into public.items (id, org_id, sku, description, base_unit)
     values ($1, $2, $3, 'Round-trip item', 'each')`,
    [itemId, org.orgId, `SKU-${itemId.slice(0, 8)}`],
  );
  await db.query(
    `insert into public.suppliers (id, org_id, name, purchasing_status)
     values ($1, $2, $3, 'approved')`,
    [supplierId, org.orgId, `Supplier ${supplierId.slice(0, 8)}`],
  );
  await db.query(
    `insert into public.cases (id, org_id, item_id, location_id, phase)
     values ($1, $2, $3, $4, 'assessing')`,
    [caseId, org.orgId, itemId, org.locationId],
  );
  fixture = { ...org, caseId, itemId, supplierId };
});

afterAll(async () => {
  if (!database) return;
  try {
    if (fixture) {
      const tables = [
        "actions",
        "assessments",
        "audit_events",
        "case_evidence",
        "evidence",
        "offers",
        "quotes",
        "planner_cycles",
        "planner_requests",
        "planner_reviews",
        "planner_waits",
        "plan_steps",
        "recovery_plans",
        "research_page_reads",
        "research_queries",
        "supplier_candidates",
        "usage_events",
        "cases",
        "items",
        "suppliers",
        "locations",
      ];
      await database.query("set session_replication_role = replica");
      try {
        for (const table of tables) {
          await database.query(`delete from public.${table} where org_id = $1`, [
            fixture.orgId,
          ]);
        }
        await database.query("delete from public.organizations where id = $1", [
          fixture.orgId,
        ]);
      } finally {
        await database.query("set session_replication_role = default");
      }
    }
  } finally {
    await database.end();
  }
});

describe("SupabasePlannerStore write round trips", () => {
  it("writes and reads back assessment, planner, recovery, research, and audit records", async () => {
    if (!database || !fixture || !store) {
      throw new Error("Planner store fixture was not initialized");
    }
    const db = database;
    const { orgId, caseId, itemId, locationId, supplierId } = fixture;
    const planner = store;
    const sourceAsOf = "2026-10-12T14:00:00.000Z";

    const assessment = await planner.insertAssessment({
      org_id: orgId,
      case_id: caseId,
      version: 1,
      input_fingerprint: "planner-store-roundtrip",
      policy_version_id: null,
      quality: "sufficient",
      first_shortage_at: null,
      bridge_qty: 0,
      projection: {},
      dated_requirements: [],
      evidence_ids: [],
      source_as_of: sourceAsOf,
      horizon_start: null,
      horizon_end: null,
    });
    const assessmentRow = (
      await db.query(
        `select source_as_of from public.assessments where id = $1 and org_id = $2`,
        [assessment.id, orgId],
      )
    ).rows[0];
    expect(new Date(assessment.source_as_of!).toISOString()).toBe(sourceAsOf);
    expect(new Date(assessmentRow.source_as_of).toISOString()).toBe(sourceAsOf);

    await planner.setCurrentAssessment(orgId, caseId, assessment.id);
    await planner.updateCasePhase(
      orgId,
      caseId,
      "monitoring",
      "2026-10-13T14:00:00.000Z",
    );
    const caseRow = (
      await db.query(
        `select current_assessment_id, phase, next_check_at
         from public.cases where id = $1 and org_id = $2`,
        [caseId, orgId],
      )
    ).rows[0];
    expect(caseRow.current_assessment_id).toBe(assessment.id);
    expect(caseRow.phase).toBe("monitoring");
    expect(new Date(caseRow.next_check_at).toISOString()).toBe(
      "2026-10-13T14:00:00.000Z",
    );

    const actionId = randomUUID();
    await db.query(
      `insert into public.actions
         (id, org_id, case_id, kind, payload_hash, payload, idempotency_key, mode)
       values ($1, $2, $3, 'supplier_email', 'roundtrip', '{}'::jsonb, $4, 'replay')`,
      [actionId, orgId, caseId, `store-test-${actionId}`],
    );
    await planner.updateActionState(orgId, caseId, actionId, "failed");
    const actionRow = (
      await db.query("select state from public.actions where id = $1 and org_id = $2", [
        actionId,
        orgId,
      ])
    ).rows[0];
    expect(actionRow.state).toBe("failed");

    const offer = await planner.insertOffer({
      org_id: orgId,
      case_id: caseId,
      supplier_id: supplierId,
      contact_id: null,
      evidence_ids: [],
      source_type: "planner",
      source_summary: "Round-trip offer",
    });
    expect(
      (
        await db.query("select source_type from public.offers where id = $1", [
          offer.id,
        ])
      ).rows[0].source_type,
    ).toBe("planner");

    const quote = await planner.insertQuote({
      org_id: orgId,
      case_id: caseId,
      offer_id: offer.id,
      supplier_id: supplierId,
      contact_id: null,
      item_id: itemId,
      quantity: 1,
      unit: "each",
      unit_price_minor: "100",
      currency: "USD",
      freight_minor: null,
      fees_minor: null,
      nonrecoverable_tax_minor: null,
      destination_location_id: locationId,
      arrival_start: null,
      arrival_end: null,
      valid_until: null,
      latest_order_at: null,
      status: "provisional",
      evidence_ids: [],
    });
    expect(
      (
        await db.query("select offer_id, item_id from public.quotes where id = $1", [
          quote.id,
        ])
      ).rows[0],
    ).toEqual({ offer_id: offer.id, item_id: itemId });

    const evidence = await planner.insertEvidence({
      org_id: orgId,
      source_type: "public_web",
      source_url: "https://supplier.example/offer",
      source_time: null,
      captured_at: "2026-10-12T14:00:00.000Z",
      content_hash: "a".repeat(64),
      supported_excerpt: "Round-trip supplier evidence",
    });
    expect(
      (
        await db.query("select source_url from public.evidence where id = $1", [
          evidence.id,
        ])
      ).rows[0].source_url,
    ).toBe("https://supplier.example/offer");

    const link = {
      org_id: orgId,
      case_id: caseId,
      evidence_id: evidence.id,
      purpose: "research",
    };
    await planner.linkCaseEvidence(link);
    await planner.linkCaseEvidence(link);
    const links = await db.query(
      `select purpose from public.case_evidence
       where org_id = $1 and case_id = $2 and evidence_id = $3`,
      [orgId, caseId, evidence.id],
    );
    expect(links.rows).toEqual([{ purpose: "research" }]);

    const researchQuery = await planner.insertResearchQuery({
      org_id: orgId,
      case_id: caseId,
      episode: 1,
      query: "round-trip supplier search",
      provider: "exa",
      mode: "replay",
      provider_request_id: null,
      result_count: 1,
      cost_usd: null,
    });
    expect(
      (
        await db.query("select provider from public.research_queries where id = $1", [
          researchQuery.id,
        ])
      ).rows[0].provider,
    ).toBe("exa");

    const candidate = await planner.insertSupplierCandidate({
      org_id: orgId,
      case_id: caseId,
      research_query_id: researchQuery.id,
      name: "Round-trip supplier",
      domain: "supplier.example",
      source_evidence_id: evidence.id,
      compatibility: "unknown",
      status: "unapproved",
      missing_facts: ["lead_time"],
    });
    expect(
      (
        await db.query(
          "select research_query_id, source_evidence_id from public.supplier_candidates where id = $1",
          [candidate.id],
        )
      ).rows[0],
    ).toEqual({
      research_query_id: researchQuery.id,
      source_evidence_id: evidence.id,
    });

    await planner.insertPageRead(orgId, caseId, 1, evidence.id);
    await planner.insertPageRead(orgId, caseId, 1, evidence.id);
    const pageReads = await db.query(
      `select evidence_id from public.research_page_reads
       where org_id = $1 and case_id = $2 and episode = 1`,
      [orgId, caseId],
    );
    expect(pageReads.rows).toEqual([{ evidence_id: evidence.id }]);

    const review = await planner.insertReview({
      org_id: orgId,
      case_id: caseId,
      reason: "Round-trip review",
      missing_fields: ["quantity"],
      object_ids: [assessment.id],
      status: "open",
      created_by: "planner",
    });
    expect(
      (
        await db.query("select reason from public.planner_reviews where id = $1", [
          review.id,
        ])
      ).rows[0].reason,
    ).toBe("Round-trip review");

    const wait = await planner.insertWait({
      org_id: orgId,
      case_id: caseId,
      episode: 1,
      expected_kind: "action_outcome",
      action_id: actionId,
      deadline_at: "2026-10-13T14:00:00.000Z",
      status: "pending",
      created_at: "2026-10-12T14:00:00.000Z",
    });
    await planner.updateWaitStatus(orgId, caseId, wait.id, "satisfied");
    expect(
      (
        await db.query("select status from public.planner_waits where id = $1", [
          wait.id,
        ])
      ).rows[0].status,
    ).toBe("satisfied");

    const cycleId = randomUUID();
    const cycle = await planner.insertCycle({
      id: cycleId,
      org_id: orgId,
      case_id: caseId,
      episode: 1,
      assessment_version: 1,
      status: "running",
      block_reason: null,
      model_requests: 0,
      prompt_version: "roundtrip",
      started_at: "2026-10-12T14:00:00.000Z",
      ended_at: null,
    });
    await planner.updateCycle(orgId, cycle.id, {
      status: "no_action",
      block_reason: null,
      model_requests: 1,
      ended_at: "2026-10-12T14:01:00.000Z",
    });
    expect(
      (
        await db.query(
          "select status, model_requests from public.planner_cycles where id = $1",
          [cycle.id],
        )
      ).rows[0],
    ).toEqual({ status: "no_action", model_requests: 1 });

    const plannerRequest = await planner.insertPlannerRequest({
      org_id: orgId,
      case_id: caseId,
      cycle_id: cycle.id,
      episode: 1,
      kind: "inference",
      outcome: "ok",
      provider: "deepseek",
      provider_request_id: `planner-${randomUUID()}`,
      model: "deepseek-chat",
      prompt_version: "roundtrip",
      estimated_cost: null,
    });
    expect(
      (
        await db.query("select outcome from public.planner_requests where id = $1", [
          plannerRequest.id,
        ])
      ).rows[0].outcome,
    ).toBe("ok");

    const usageRequestId = `planner-${randomUUID()}`;
    await planner.insertUsageEvent({
      orgId,
      caseId,
      provider: "deepseek",
      requestId: usageRequestId,
      chargeType: "planner",
      model: "deepseek-chat",
      rawUnits: { prompt_tokens: 3, completion_tokens: 2 },
    });
    expect(
      (
        await db.query(
          `select raw_units from public.usage_events
           where org_id = $1 and provider = 'deepseek' and request_id = $2 and charge_type = 'planner'`,
          [orgId, usageRequestId],
        )
      ).rows[0].raw_units,
    ).toEqual({ prompt_tokens: 3, completion_tokens: 2 });

    const recoveryPlan = await planner.insertRecoveryPlan({
      orgId,
      caseId,
      version: 1,
      assessmentId: assessment.id,
      status: "draft",
      grossCommitmentMinor: "100",
      incrementalCostMinor: null,
      evidenceIds: [evidence.id],
      steps: [
        {
          step_id: "purchase",
          kind: "purchase_bridge",
          item_id: itemId,
          quantity: 1,
          unit: "each",
          missing_fields: [],
        },
      ],
    });
    expect(
      (
        await db.query(
          "select status from public.recovery_plans where id = $1 and org_id = $2",
          [recoveryPlan.id, orgId],
        )
      ).rows[0].status,
    ).toBe("draft");
    expect(
      (
        await db.query(
          "select kind, item_id from public.plan_steps where plan_id = $1 and org_id = $2",
          [recoveryPlan.id, orgId],
        )
      ).rows[0],
    ).toEqual({ kind: "purchase_bridge", item_id: itemId });

    await planner.insertAudit({
      org_id: orgId,
      case_id: caseId,
      actor_type: "workflow",
      entity_type: "case",
      entity_id: caseId,
      event_name: "roundtrip",
      reason: "Store write round trip",
    });
    expect(
      (
        await db.query(
          `select event_name, reason from public.audit_events
           where org_id = $1 and case_id = $2 and event_name = 'roundtrip'`,
          [orgId, caseId],
        )
      ).rows[0],
    ).toEqual({ event_name: "roundtrip", reason: "Store write round trip" });
  });
});
