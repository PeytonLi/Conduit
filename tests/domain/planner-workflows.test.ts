import { describe, expect, it } from "vitest";
import { runCaseAssessment } from "@/lib/workflows/case-assessment";
import { runCaseRecovery } from "@/lib/workflows/case-recovery";
import { createReplayModel } from "@/lib/integrations/deepseek/replay";
import type { ProjectionInput, ProjectionResult } from "@/lib/domain/types";
import canonical from "@/lib/integrations/deepseek/replay-transcripts/canonical-recovery.json";
import {
  ASSESSMENT_A,
  CASE_A,
  ctx,
  FakeRecoveryStep,
  FakeStep,
  harborStore,
  clock,
} from "./planner-test-helpers";
import type { ReplayTranscript } from "@/lib/integrations/deepseek/replay";

function projectionResult(overrides: Partial<ProjectionResult> = {}): ProjectionResult {
  return {
    quality: "sufficient",
    missingFacts: [],
    points: [],
    firstShortageAt: "2026-10-14T16:00:00Z",
    bridgeQuantity: 600,
    requirements: [
      { by: "2026-10-14T16:00:00Z", cumulativeQuantity: 200 },
      { by: "2026-10-15T16:00:00Z", cumulativeQuantity: 600 },
    ],
    inputFingerprint: "fp-1",
    ...overrides,
  };
}

const projectionInput: ProjectionInput = {
  t0: "2026-10-12T15:00:00Z",
  timezone: "America/Los_Angeles",
  unit: "carton",
  horizonEnd: "2026-10-20T00:00:00Z",
  physicalQty: 0,
  unusableQty: 0,
  outsideAllocationsQty: 0,
  safetyBufferQty: 0,
  receipts: [],
  demand: [],
  pendingClaims: [],
};

function assessmentDeps(store = harborStore(), result = projectionResult()) {
  const seeded = store;
  seeded.projectionInput = projectionInput;
  const step = new FakeRecoveryStep();
  return {
    store: seeded,
    step,
    project: () => result,
    clock,
  };
}

describe("case-assessment workflow", () => {
  it("reuses assessment on unchanged fingerprint (no insert, no model call)", async () => {
    const deps = assessmentDeps();
    const before = deps.store.assessments.size;
    const out = await runCaseAssessment(deps, { case_id: CASE_A });
    expect(deps.store.assessments.size).toBe(before);
    expect(out.status).toBe("ok");
    const c = await deps.store.getCase(ctx.orgId, CASE_A);
    expect(c?.phase).toBe("recovering");
    expect(deps.step.sends.some((s) => s.name === "case.recovery.requested")).toBe(true);
  });

  it("inserts a new version when the fingerprint changes", async () => {
    const deps = assessmentDeps(harborStore(), projectionResult({ inputFingerprint: "fp-2" }));
    const out = await runCaseAssessment(deps, { case_id: CASE_A });
    expect(out.assessment_version).toBe(2);
    const c = await deps.store.getCase(ctx.orgId, CASE_A);
    expect(c?.current_assessment_id).not.toBe(ASSESSMENT_A);
  });

  it("insufficient quality -> needs_review", async () => {
    const deps = assessmentDeps(
      harborStore(),
      projectionResult({
        quality: "insufficient",
        bridgeQuantity: 0,
        inputFingerprint: "fp-insufficient",
      }),
    );
    await runCaseAssessment(deps, { case_id: CASE_A });
    const c = await deps.store.getCase(ctx.orgId, CASE_A);
    expect(c?.phase).toBe("needs_review");
  });

  it("no shortage -> monitoring", async () => {
    const deps = assessmentDeps(
      harborStore({ phase: "assessing" }),
      projectionResult({
        firstShortageAt: null,
        bridgeQuantity: 0,
        requirements: [],
        inputFingerprint: "fp-3",
      }),
    );
    await runCaseAssessment(deps, { case_id: CASE_A });
    const c = await deps.store.getCase(ctx.orgId, CASE_A);
    expect(c?.phase).toBe("monitoring");
    expect(deps.step.sends.length).toBe(0);
  });
});

describe("case-recovery workflow", () => {
  it("exits without planner calls when case is paused", async () => {
    const store = harborStore({ runControl: "paused" });
    const step = new FakeRecoveryStep();
    let calls = 0;
    const model = { async complete() { calls += 1; throw new Error("x"); } };
    const out = await runCaseRecovery(
      { store, model, clock, step },
      { case_id: CASE_A, assessment_version: 1 },
    );
    expect(out.status).toBe("paused");
    expect(calls).toBe(0);
  });

  it("exits on stale assessment_version", async () => {
    const store = harborStore();
    const step = new FakeRecoveryStep();
    const model = createReplayModel(canonical as ReplayTranscript);
    const out = await runCaseRecovery(
      { store, model, clock, step },
      { case_id: CASE_A, assessment_version: 99 },
    );
    expect(out.status).toBe("stale");
  });

  it("canonical replay transcript ends waiting_continued with one prepared email to Bay Carton", async () => {
    const store = harborStore();
    const step = new FakeRecoveryStep();
    const model = createReplayModel(canonical as ReplayTranscript);
    const out = await runCaseRecovery(
      { store, model, clock, step, env: {} },
      { case_id: CASE_A, assessment_version: 1 },
    );
    // Fixed clock: the wait deadline is ~41h out, so the 120-tick cap is hit
    // first and the run hands off via a continuation event.
    expect(out.status).toBe("waiting_continued");
    const emails = [...store.actions.values()].filter(
      (a) => a.kind === "supplier_email",
    );
    expect(emails.length).toBe(1);
    expect(emails[0].state).toBe("prepared");
    expect(emails[0].payload.recipient).toBe("sales@baycarton.example.com");
    // waitForEvent ticks were attempted and bounded by the tick cap.
    expect(step.waits.length).toBe(120);
    expect(step.waits.every((w) => w.opts.timeout === "60s")).toBe(true);
    // Continuation event re-fires case.recovery.requested.
    expect(
      step.sends.some(
        (s) =>
          s.name === "case.recovery.requested" &&
          s.data.case_id === CASE_A &&
          s.data.assessment_version === 1,
      ),
    ).toBe(true);
    // Step ids unique across the whole run.
    const allIds = [
      ...step.runs,
      ...step.sleeps.map((s) => s.id),
      ...step.waits.map((w) => w.id),
      ...step.sends.map((s) => s.id),
    ];
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it("a run started with a persisted pending wait waits first, then plans", async () => {
    const store = harborStore();
    const step = new FakeRecoveryStep();
    // Pending wait for the current episode whose outcome is already persisted.
    const wait = await store.insertWait({
      org_id: ctx.orgId,
      case_id: CASE_A,
      episode: 1,
      expected_kind: "supplier_response",
      action_id: null,
      deadline_at: "2026-10-14T08:00:00Z",
      status: "pending",
      created_at: "2026-10-12T14:00:00Z",
    });
    const ev = await store.insertEvidence({
      org_id: ctx.orgId,
      source_type: "supplier_email",
      source_url: null,
      source_time: null,
      captured_at: "2026-10-12T16:00:00Z",
      content_hash: "h",
      supported_excerpt: "reply",
    });
    await store.linkCaseEvidence({
      org_id: ctx.orgId,
      case_id: CASE_A,
      evidence_id: ev.id,
      purpose: "supplier_response",
    });
    const model = createReplayModel(canonical as ReplayTranscript);
    const out = await runCaseRecovery(
      { store, model, clock, step, env: {} },
      { case_id: CASE_A, assessment_version: 1 },
    );
    // Persisted outcome found before any waitForEvent tick or model call.
    expect(step.waits.length).toBe(0);
    const checkIdx = step.runs.indexOf("check-0-0");
    const inferIdx = step.runs.findIndex((id) => id.startsWith("c0-infer"));
    expect(checkIdx).toBeGreaterThanOrEqual(0);
    expect(inferIdx).toBeGreaterThan(checkIdx);
    expect(store.waits.get(wait.id)?.status).toBe("satisfied");
    // The cycle then ran the transcript and ended waiting again — one wait
    // loop per run, so the run hands off with a continuation event.
    expect(out.status).toBe("waiting_continued");
    expect(step.sends.some((s) => s.name === "case.recovery.requested")).toBe(
      true,
    );
  });

  it("persisted supplier response before first tick -> waitForEvent NOT called", async () => {
    const store = harborStore();
    // Pre-seed a satisfied wait + response evidence.
    const step = new FakeRecoveryStep();
    const model = createReplayModel(canonical as ReplayTranscript);
    // Make findSatisfiedWait true by marking any inserted wait satisfied immediately:
    const origInsert = store.insertWait.bind(store);
    store.insertWait = async (rec) => {
      const row = await origInsert(rec);
      // Evidence of a supplier response recorded after wait creation.
      const ev = await store.insertEvidence({
        org_id: rec.org_id,
        source_type: "supplier_email",
        source_url: null,
        source_time: null,
        captured_at: "2026-10-12T16:00:00Z",
        content_hash: "h",
        supported_excerpt: "reply",
      });
      await store.linkCaseEvidence({
        org_id: rec.org_id,
        case_id: rec.case_id,
        evidence_id: ev.id,
        purpose: "supplier_response",
      });
      return row;
    };
    const out = await runCaseRecovery(
      { store, model, clock, step, env: {} },
      { case_id: CASE_A, assessment_version: 1 },
    );
    expect(step.waits.length).toBe(0);
    expect(["waiting", "no_action", "needs_review", "plan_proposed", "blocked"]).toContain(
      out.status,
    );
    const wait = [...store.waits.values()][0];
    expect(wait.status).toBe("satisfied");
  });
});

describe("FakeStep recording", () => {
  it("records run and sleep calls", async () => {
    const step = new FakeStep();
    await step.run("a", () => 1);
    await step.sleep("b", 100);
    expect(step.runs).toEqual(["a"]);
    expect(step.sleeps).toEqual([{ id: "b", ms: 100 }]);
  });
});
