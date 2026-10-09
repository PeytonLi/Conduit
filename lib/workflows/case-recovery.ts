import { createHash } from "node:crypto";
import { inngest } from "./client";
import type { Clock } from "@/lib/agent/clock";
import { systemClock } from "@/lib/agent/clock";
import type { PlannerModel } from "@/lib/agent/model";
import type { PlannerStore, PlannerWaitRecord } from "@/lib/agent/store";
import { SupabasePlannerStore } from "@/lib/agent/store-supabase";
import { createToolRegistry } from "@/lib/agent/tools/registry";
import { createReplayModel } from "@/lib/integrations/deepseek/replay";
import { createDeepSeekModel } from "@/lib/integrations/deepseek/client";
import { selectResearch } from "@/lib/integrations/exa/replay";
import { runPlannerCycle, type CycleOutcome, type StepTools } from "@/lib/agent/planner";
import type { AgentToolContext } from "@/lib/agent/tools/types";
import { parseServerEnv } from "@/lib/env";
import { flushTelemetry } from "@/lib/telemetry";
import canonicalTranscript from "@/lib/integrations/deepseek/replay-transcripts/canonical-recovery.json";

export interface RecoveryStepTools extends StepTools {
  waitForEvent(
    id: string,
    opts: { event: string; timeout: number | string; if?: string },
  ): Promise<unknown>;
  sendEvent(id: string, payload: { name: string; data: Record<string, unknown> }): Promise<unknown>;
}

export interface RecoveryDeps {
  store: PlannerStore;
  model: PlannerModel;
  clock: Clock;
  step: RecoveryStepTools;
  env?: { EXA_API_KEY?: string };
}

const WAIT_EVENTS: Record<PlannerWaitRecord["expected_kind"], string> = {
  supplier_response: "supplier.response.recorded",
  call_result: "supplier.call.finished",
  action_outcome: "action.outcome.recorded",
};

function cycleUuid(caseId: string, assessmentVersion: number, index: number): string {
  const hex = createHash("sha256")
    .update(`${caseId}:${assessmentVersion}:${index}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function runCaseRecovery(
  deps: RecoveryDeps,
  data: { case_id: string; assessment_version: number },
): Promise<{ status: string }> {
  const { store, step, clock } = deps;

  const loaded = await step.run("load", async () => {
    const c = store.getCaseByIdOnly ? await store.getCaseByIdOnly(data.case_id) : null;
    if (!c) return { exit: "not_found" as const };
    if (c.run_control !== "active") return { exit: "paused" as const };
    const current = await store.getCurrentAssessment(c.org_id, c.id);
    if (!current || current.version !== data.assessment_version) {
      return { exit: "stale" as const };
    }
    return { caseRow: c, assessment: current };
  });
  if ("exit" in loaded) return { status: loaded.exit as string };
  const c = loaded.caseRow!;
  const orgId = c.org_id;
  const ctx: AgentToolContext = {
    orgId,
    caseId: c.id,
    actor: "planner",
    correlationId: c.id,
    mode: (process.env.APP_ENV === "replay" ? "replay" : process.env.APP_ENV === "live" ? "live" : "sandbox") as AgentToolContext["mode"],
  };

  const tools = createToolRegistry({
    store,
    clock,
    research: selectResearch(deps.env ?? {}, ctx.mode, { clock }),
  });

  const MAX_CYCLES = 6;
  const TICK_CAP = 120; // Inngest ~1000-step-per-run budget.
  let waitLoopIndex = 0;

  /**
   * One bounded wait loop. Returns "satisfied" (deadline-independent persisted
   * outcome), "expired" (deadline reached), "continued" (tick cap hit first —
   * a continuation event was sent), or "paused".
   */
  const runWaitLoop = async (
    wait: PlannerWaitRecord,
  ): Promise<"satisfied" | "expired" | "continued" | "paused"> => {
    const w = waitLoopIndex++;
    const plan = await step.run(`wait-plan-${w}`, () => {
      const deadlineMs = new Date(wait.deadline_at).getTime();
      return {
        deadlineMs,
        maxTicks: Math.min(
          TICK_CAP,
          Math.max(0, Math.ceil((deadlineMs - clock.now().getTime()) / 60_000)),
        ),
      };
    });
    for (let t = 0; t < plan.maxTicks; t++) {
      const check = await step.run(`check-${w}-${t}`, async () => {
        const current = await store.getCase(orgId, c.id);
        if (!current || current.run_control !== "active") return "paused" as const;
        return (await store.findSatisfiedWait(orgId, c.id, wait))
          ? ("yes" as const)
          : ("no" as const);
      });
      if (check === "paused") return "paused";
      if (check === "yes") {
        await step.run(`wait-satisfied-${w}-${t}`, () =>
          store.updateWaitStatus(orgId, c.id, wait.id, "satisfied"),
        );
        return "satisfied";
      }
      const eventName = WAIT_EVENTS[wait.expected_kind];
      const match =
        wait.expected_kind === "action_outcome" && wait.action_id
          ? `async.data.case_id == '${c.id}' && async.data.action_id == '${wait.action_id}'`
          : `async.data.case_id == '${c.id}'`;
      await step.waitForEvent(`wait-${w}-${t}`, {
        event: eventName,
        timeout: "60s",
        if: match,
      });
      // Event is only a hint — loop back to the persisted check.
    }
    const deadlineReached = await step.run(
      `wait-deadline-${w}`,
      () => clock.now().getTime() >= plan.deadlineMs,
    );
    if (deadlineReached) {
      await step.run(`wait-expired-${w}`, () =>
        store.updateWaitStatus(orgId, c.id, wait.id, "expired"),
      );
      return "expired";
    }
    // Tick cap exhausted before the deadline: hand off to a continuation run
    // instead of stalling the case inside a single run's step budget.
    await step.sendEvent(`continue-${w}`, {
      name: "case.recovery.requested",
      data: { case_id: c.id, assessment_version: data.assessment_version },
    });
    return "continued";
  };

  // Resume: if a pending wait already exists for the current episode, wait
  // FIRST instead of re-planning (continuation runs land here).
  const pendingWait = await step.run("find-pending-wait", async () => {
    const waits = await store.listWaits(orgId, c.id);
    return (
      waits.find((w) => w.episode === c.episode && w.status === "pending") ??
      null
    );
  });
  let waitedThisRun = false;
  if (pendingWait) {
    waitedThisRun = true;
    const res = await runWaitLoop(pendingWait);
    if (res === "paused") return { status: "paused" };
    if (res === "continued") {
      await step.run("flush-telemetry", () => flushTelemetry());
      return { status: "waiting_continued" };
    }
    // satisfied | expired → fall through to planner cycles.
  }

  let outcome: CycleOutcome = { status: "no_action", modelRequests: 0 };

  for (let i = 0; i < MAX_CYCLES; i++) {
    const fresh = await step.run(`reload-${i}`, () => store.getCase(orgId, c.id));
    if (!fresh || fresh.run_control !== "active") return { status: "paused" };

    outcome = await runPlannerCycle(
      { model: deps.model, tools, store, clock, step },
      {
        ...ctx,
        episode: fresh.episode,
        assessmentVersion: data.assessment_version,
        cycleId: cycleUuid(c.id, data.assessment_version, i),
        cycleIndex: i,
      },
    );

    if (outcome.status !== "waiting") break;

    if (waitedThisRun) {
      // One wait loop per run: a second wait is handled by the continuation.
      await step.sendEvent(`continue-${waitLoopIndex++}`, {
        name: "case.recovery.requested",
        data: { case_id: c.id, assessment_version: data.assessment_version },
      });
      await step.run("flush-telemetry", () => flushTelemetry());
      return { status: "waiting_continued" };
    }

    const wait = await step.run(`find-wait-${i}`, async () => {
      const waits = await store.listWaits(orgId, c.id);
      return (
        waits.find(
          (w) => w.episode === fresh.episode && w.status === "pending",
        ) ?? null
      );
    });
    if (!wait) return { status: "waiting_no_wait_row" };

    waitedThisRun = true;
    const res = await runWaitLoop(wait);
    if (res === "paused") return { status: "paused" };
    if (res === "continued") {
      await step.run("flush-telemetry", () => flushTelemetry());
      return { status: "waiting_continued" };
    }
    // satisfied | expired → next cycle.
  }

  await step.run("flush-telemetry", () => flushTelemetry());
  return { status: outcome.status };
}

function defaultRecoveryDeps(step: RecoveryStepTools): RecoveryDeps {
  const env = parseServerEnv(process.env);
  const store = new SupabasePlannerStore();
  const mode = env.APP_ENV;
  const model =
    mode === "replay"
      ? createReplayModel(canonicalTranscript as unknown as import("@/lib/integrations/deepseek/replay").ReplayTranscript)
      : createDeepSeekModel(env);
  return {
    store,
    model,
    clock: systemClock,
    step,
    env: { EXA_API_KEY: env.EXA_API_KEY },
  };
}

export const caseRecoveryFunction = inngest.createFunction(
  {
    id: "case-recovery",
    triggers: [{ event: "case.recovery.requested" }],
    concurrency: [{ key: "event.data.case_id", limit: 1 }],
  },
  async ({ event, step }) =>
    runCaseRecovery(
      defaultRecoveryDeps(step as unknown as RecoveryStepTools),
      event.data as { case_id: string; assessment_version: number },
    ),
);
