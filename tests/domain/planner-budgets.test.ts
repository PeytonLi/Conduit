import { describe, expect, it } from "vitest";
import { runPlannerCycle } from "@/lib/agent/planner";
import { createToolRegistry } from "@/lib/agent/tools/registry";
import { ModelCallError } from "@/lib/agent/model";
import {
  createFakePreparer,
  ctx,
  FakeStep,
  harborStore,
  scriptedModel,
  toolCallTurn,
  contentDecision,
  clock,
} from "./planner-test-helpers";

function deps(store = harborStore(), tools = createToolRegistry({ store, clock, preparer: createFakePreparer(store) })) {
  return { tools, store, clock };
}

describe("AT-35 planner budgets and NFR-011", () => {
  it("looping model stops at 8 requests/cycle -> blocked budget_exhausted + review", async () => {
    const store = harborStore();
    const { tools } = deps(store);
    // read_case forever with varying args to dodge the loop guard.
    const model = scriptedModel(
      Array.from({ length: 20 }, (_, i) =>
        toolCallTurn("read_case", { probe: i }),
      ),
    );
    const step = new FakeStep();
    const outcome = await runPlannerCycle(
      { model, tools, store, clock, step },
      { ...ctx, episode: 1, assessmentVersion: 1, cycleId: "cyc-loop" },
    );
    expect(outcome.status).toBe("blocked");
    expect(outcome.blockReason).toBe("budget_exhausted");
    const requests = [...store.requests.values()].filter(
      (r) => r.cycle_id && r.case_id === ctx.caseId,
    );
    expect(requests.length).toBe(8);
    expect([...store.reviews.values()].length).toBe(1);
  });

  it("episode cap of 24 is enforced across cycles", async () => {
    const store = harborStore();
    const { tools } = deps(store);
    // Seed 20 persisted requests in the episode.
    for (let i = 0; i < 20; i++) {
      await store.insertPlannerRequest({
        org_id: ctx.orgId,
        case_id: ctx.caseId,
        cycle_id: "old-cycle",
        episode: 1,
        kind: "inference",
        outcome: "ok",
        provider: "deepseek",
        provider_request_id: `r${i}`,
        model: "m",
        prompt_version: "planner-v1",
        estimated_cost: null,
      });
    }
    const model = scriptedModel(
      Array.from({ length: 10 }, (_, i) => toolCallTurn("read_case", { probe: i })),
    );
    const step = new FakeStep();
    const outcome = await runPlannerCycle(
      { model, tools, store, clock, step },
      { ...ctx, episode: 1, assessmentVersion: 1, cycleId: "cyc-ep" },
    );
    expect(outcome.status).toBe("blocked");
    expect(outcome.blockReason).toBe("budget_exhausted");
    const total = await store.countPlannerRequests(ctx.orgId, ctx.caseId, 1);
    expect(total).toBe(24);
  });

  it("identical tool call twice in one cycle -> loop guard review", async () => {
    const store = harborStore();
    const { tools } = deps(store);
    const model = scriptedModel([
      toolCallTurn("read_case", {}),
      toolCallTurn("read_case", {}),
    ]);
    const step = new FakeStep();
    const outcome = await runPlannerCycle(
      { model, tools, store, clock, step },
      { ...ctx, episode: 1, assessmentVersion: 1, cycleId: "cyc-dup" },
    );
    expect(outcome.status).toBe("needs_review");
    const reasons = [...store.reviews.values()].map((r) => r.reason);
    expect(reasons.join(" ")).toContain("repeated tool request");
  });

  it("invalid JSON twice -> exactly 2 requests (1 repair) -> needs_review", async () => {
    const store = harborStore();
    const { tools } = deps(store);
    const model = scriptedModel([
      { message: { content: "not json at all" } },
      { message: { content: "still not valid {" } },
    ]);
    const step = new FakeStep();
    const outcome = await runPlannerCycle(
      { model, tools, store, clock, step },
      { ...ctx, episode: 1, assessmentVersion: 1, cycleId: "cyc-inv" },
    );
    expect(outcome.status).toBe("needs_review");
    const requests = [...store.requests.values()].filter(
      (r) => r.cycle_id !== undefined,
    );
    expect(requests.length).toBe(2);
    expect(requests.map((r) => r.kind)).toEqual(["inference", "repair"]);
  });

  it("repeated 429 with Retry-After -> 3 attempts with backoff, then blocked provider_unavailable", async () => {
    const store = harborStore();
    const { tools } = deps(store);
    let calls = 0;
    const model = {
      async complete() {
        calls += 1;
        throw new ModelCallError("rate_limited", "rate limited", 1500);
      },
    };
    const step = new FakeStep();
    const outcome = await runPlannerCycle(
      { model, tools, store, clock, step },
      { ...ctx, episode: 1, assessmentVersion: 1, cycleId: "cyc-429" },
    );
    expect(outcome.status).toBe("blocked");
    expect(outcome.blockReason).toBe("provider_unavailable");
    expect(calls).toBe(3);
    expect(step.sleeps.length).toBe(2);
    expect(step.sleeps.every((s) => s.ms === 1500)).toBe(true);
    const outcomes = [...store.requests.values()].map((r) => r.outcome);
    expect(outcomes).toEqual(["rate_limited", "rate_limited", "rate_limited"]);
  });

  it("402 quota_exceeded -> no retry", async () => {
    const store = harborStore();
    const { tools } = deps(store);
    let calls = 0;
    const model = {
      async complete() {
        calls += 1;
        throw new ModelCallError("quota_exceeded", "billing");
      },
    };
    const step = new FakeStep();
    const outcome = await runPlannerCycle(
      { model, tools, store, clock, step },
      { ...ctx, episode: 1, assessmentVersion: 1, cycleId: "cyc-402" },
    );
    expect(calls).toBe(1);
    expect(outcome.status).toBe("blocked");
    expect(outcome.blockReason).toBe("provider_unavailable");
  });

  it("missing usage -> estimated_cost null, never '0'", async () => {
    const store = harborStore();
    const { tools } = deps(store);
    const model = scriptedModel([contentDecision("no_action", {})]);
    const step = new FakeStep();
    const outcome = await runPlannerCycle(
      { model, tools, store, clock, step },
      { ...ctx, episode: 1, assessmentVersion: 1, cycleId: "cyc-na" },
    );
    expect(outcome.status).toBe("no_action");
    const req = [...store.requests.values()][0];
    expect(req.estimated_cost).toBeNull();
  });
});
