import { describe, expect, it } from "vitest";
import { runPlannerCycle, type StepTools } from "@/lib/agent/planner";
import { createToolRegistry } from "@/lib/agent/tools/registry";
import { createReplayModel } from "@/lib/integrations/deepseek/replay";
import {
  ModelCallError,
  type ModelTurn,
  type PlannerModel,
  type ToolDef,
  type UsageRecord,
} from "@/lib/agent/model";
import canonical from "@/lib/integrations/deepseek/replay-transcripts/canonical-recovery.json";
import type { ReplayTranscript } from "@/lib/integrations/deepseek/replay";
import {
  clock,
  contentDecision,
  ctx,
  FakeStep,
  harborStore,
  scriptedModel,
} from "./planner-test-helpers";

const EMPTY_USAGE: UsageRecord = {
  provider: "deepseek",
  request_id: "r",
  model: "m",
  raw_units: {},
  estimated_cost: null,
  actual_cost: null,
  billing_currency: null,
  rate_version: null,
};

/** StepTools that memoizes step outputs by id, like Inngest does across requests. */
class MemoStep implements StepTools {
  cache = new Map<string, unknown>();
  async run<T>(id: string, fn: () => Promise<T> | T): Promise<T> {
    if (this.cache.has(id)) return this.cache.get(id) as T;
    const value = await fn();
    this.cache.set(id, value);
    return value;
  }
  async sleep(): Promise<void> {}
}

const cycleCtx = {
  ...ctx,
  episode: 1,
  assessmentVersion: 1,
  cycleId: "00000000-0000-4000-8000-00000000c001",
  cycleIndex: 0,
};

describe("planner Inngest durability", () => {
  it("re-running the cycle under memoized steps leaves one cycle row and the same request count", async () => {
    const store = harborStore();
    const tools = createToolRegistry({ store, clock });
    const model = scriptedModel([contentDecision("no_action", {})]);
    const step = new MemoStep();
    const deps = { model, tools, store, clock, step };

    const first = await runPlannerCycle(deps, cycleCtx);
    expect(first.status).toBe("no_action");
    const requestsAfterFirst = store.requests.size;
    expect(store.cycles.size).toBe(1);

    // Simulate a second Inngest request: whole function re-runs, but every
    // step returns its memoized output, so no store write executes again.
    const second = await runPlannerCycle(deps, cycleCtx);
    expect(second.status).toBe("no_action");
    expect(store.cycles.size).toBe(1);
    expect(store.requests.size).toBe(requestsAfterFirst);
  });

  it("all side-effecting writes happen inside steps", async () => {
    const store = harborStore();
    const tools = createToolRegistry({ store, clock });
    const model = scriptedModel([contentDecision("no_action", {})]);
    const step = new FakeStep();
    await runPlannerCycle({ model, tools, store, clock, step }, cycleCtx);
    expect(step.runs.some((id) => id.endsWith("cycle-start"))).toBe(true);
    expect(step.runs.some((id) => id.endsWith("cycle-finish"))).toBe(true);
  });

  it("missing case row ends the cycle as no_action", async () => {
    const store = harborStore();
    const tools = createToolRegistry({ store, clock });
    const model = scriptedModel([]);
    const outcome = await runPlannerCycle(
      { model, tools, store, clock, step: new FakeStep() },
      { ...cycleCtx, caseId: "40000000-0000-4000-8000-00000000dead" },
    );
    expect(outcome.status).toBe("no_action");
  });

  it("repair provider error ends the cycle blocked/provider_unavailable with a review", async () => {
    const store = harborStore();
    const tools = createToolRegistry({ store, clock });
    let calls = 0;
    const model: PlannerModel = {
      async complete(): Promise<ModelTurn> {
        calls += 1;
        if (calls === 1) {
          return {
            providerRequestId: "r1",
            model: "m",
            message: { content: "not json at all" },
            usage: EMPTY_USAGE,
          };
        }
        throw new ModelCallError("quota_exceeded", "quota");
      },
    };
    const outcome = await runPlannerCycle(
      { model, tools, store, clock, step: new FakeStep() },
      cycleCtx,
    );
    expect(outcome.status).toBe("blocked");
    expect(outcome.blockReason).toBe("provider_unavailable");
    expect(store.reviews.size).toBe(1);
    // Both the inference and the repair request rows were persisted.
    const kinds = [...store.requests.values()].map((r) => r.kind);
    expect(kinds).toContain("inference");
    expect(kinds).toContain("repair");
  });

  it("a successful repair turn records a usage_events row like main inference", async () => {
    const store = harborStore();
    const tools = createToolRegistry({ store, clock });
    const usage: UsageRecord = {
      ...EMPTY_USAGE,
      raw_units: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const model = scriptedModel([
      { message: { content: "garbage{" }, usage },
      {
        message: {
          content: JSON.stringify({
            schema_version: 1,
            decision_type: "no_action",
            concise_reason: "ok",
            supporting_evidence_ids: [],
            missing_facts: [],
            payload: {},
          }),
        },
        usage,
      },
    ]);
    const outcome = await runPlannerCycle(
      { model, tools, store, clock, step: new FakeStep() },
      cycleCtx,
    );
    expect(outcome.status).toBe("no_action");
    expect(store.usageEvents.length).toBe(2);
  });
});

describe("model tool definitions", () => {
  it("tool defs sent to the model carry real strict JSON schemas", async () => {
    const store = harborStore();
    const tools = createToolRegistry({ store, clock });
    let captured: ToolDef[] = [];
    const model: PlannerModel = {
      async complete(req): Promise<ModelTurn> {
        captured = req.tools;
        return {
          providerRequestId: "r1",
          model: "m",
          message: {
            content: JSON.stringify({
              schema_version: 1,
              decision_type: "no_action",
              concise_reason: "x",
              supporting_evidence_ids: [],
              missing_facts: [],
              payload: {},
            }),
          },
          usage: EMPTY_USAGE,
        };
      },
    };
    await runPlannerCycle({ model, tools, store, clock, step: new FakeStep() }, cycleCtx);
    const email = captured.find((t) => t.name === "request_supplier_email");
    expect(email).toBeDefined();
    const params = email!.parameters as {
      properties?: Record<string, unknown>;
      additionalProperties?: boolean;
    };
    expect(params.additionalProperties).toBe(false);
    expect(Object.keys(params.properties ?? {})).toContain("contact_id");
    expect(captured.length).toBeGreaterThan(0);
  });
});

describe("replay model sequence indexing", () => {
  it("two separately constructed replay models honor sequence 0 and 1", async () => {
    const transcript = canonical as ReplayTranscript;
    const a = createReplayModel(transcript);
    const b = createReplayModel(transcript);
    const t0 = await a.complete({ messages: [], tools: [], sequence: 0 });
    const t1 = await b.complete({ messages: [], tools: [], sequence: 1 });
    expect(t0.providerRequestId).not.toBe(t1.providerRequestId);
    expect(t0.message.tool_calls?.[0]?.name).toBe("read_case");
    expect(t1.message.tool_calls?.[0]?.name).toBe("list_approved_suppliers");
  });

  it("without a sequence the in-memory cursor advances", async () => {
    const model = createReplayModel(canonical as ReplayTranscript);
    const t0 = await model.complete({ messages: [], tools: [] });
    const t1 = await model.complete({ messages: [], tools: [] });
    expect(t0.message.tool_calls?.[0]?.name).toBe("read_case");
    expect(t1.message.tool_calls?.[0]?.name).toBe("list_approved_suppliers");
  });
});
