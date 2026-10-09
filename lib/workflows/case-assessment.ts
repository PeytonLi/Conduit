import { inngest } from "./client";
import type { Clock } from "@/lib/agent/clock";
import { systemClock } from "@/lib/agent/clock";
import type { PlannerStore } from "@/lib/agent/store";
import { SupabasePlannerStore } from "@/lib/agent/store-supabase";
import { defaultProjector, type InventoryProjector } from "@/lib/agent/ports";
import { transitionAllowed } from "@/lib/agent/phases";
import { withBusinessSpan, flushTelemetry, orgPseudonym } from "@/lib/telemetry";

export interface AssessmentStepTools {
  run<T>(id: string, fn: () => Promise<T> | T): Promise<T>;
  sendEvent(id: string, payload: { name: string; data: Record<string, unknown> }): Promise<unknown>;
}

export interface AssessmentDeps {
  store: PlannerStore;
  project: InventoryProjector;
  clock: Clock;
  step: AssessmentStepTools;
}

export async function runCaseAssessment(
  deps: AssessmentDeps,
  data: { case_id: string; source_version?: number },
): Promise<{ status: string; assessment_version?: number }> {
  const { store, step } = deps;

  const caseRow = await step.run("load", async () => {
    // org_id is resolved via the case row using the service store.
    const found = await findCaseById(store, data.case_id);
    if (!found) throw new Error("case not found");
    if (found.run_control === "paused") return { paused: true as const, caseRow: found };
    return { paused: false as const, caseRow: found };
  });
  if (caseRow.paused) return { status: "skipped_paused" };
  const c = caseRow.caseRow;
  const orgId = c.org_id;

  const current = await step.run("current", () =>
    store.getCurrentAssessment(orgId, c.id),
  );

  const projection = await step.run("project", async () => {
    const input = await store.loadProjectionInput(orgId, c.id);
    return withBusinessSpan(
      "inventory_calc",
      { org_pseudonym: orgPseudonym(orgId), case_id: c.id, episode: c.episode },
      () => deps.project(input),
    );
  });

  const result = await step.run("persist", async () => {
    if (current && current.input_fingerprint === projection.inputFingerprint) {
      return { reused: true as const, assessment: current };
    }
    const version = current ? current.version + 1 : 1;
    const inserted = await store.insertAssessment({
      org_id: orgId,
      case_id: c.id,
      version,
      input_fingerprint: projection.inputFingerprint,
      policy_version_id: current?.policy_version_id ?? null,
      quality: projection.quality,
      first_shortage_at: projection.firstShortageAt,
      bridge_qty: projection.bridgeQuantity,
      projection: { points: projection.points },
      dated_requirements: projection.requirements.map((r) => ({
        by: r.by,
        cumulative_quantity: r.cumulativeQuantity,
      })),
      evidence_ids: [],
      source_as_of: deps.clock.now().toISOString(),
      horizon_start: null,
      horizon_end: null,
    });
    await store.setCurrentAssessment(orgId, c.id, inserted.id);
    return { reused: false as const, assessment: inserted };
  });

  const phase = await step.run("phase", async () => {
    let target: typeof c.phase | null = null;
    if (result.assessment.quality === "insufficient") target = "needs_review";
    else if ((result.assessment.bridge_qty ?? 0) > 0) target = "recovering";
    else target = "monitoring";

    if (transitionAllowed(c.phase, target)) {
      if (target !== c.phase) await store.updateCasePhase(orgId, c.id, target);
    } else {
      await store.insertAudit?.({
        org_id: orgId,
        case_id: c.id,
        actor_type: "workflow",
        entity_type: "case",
        entity_id: c.id,
        event_name: "phase_transition_denied",
        reason: `${c.phase} -> ${target} not allowed`,
      });
    }
    return target;
  });

  if (phase === "recovering") {
    await step.sendEvent("request-recovery", {
      name: "case.recovery.requested",
      data: { case_id: c.id, assessment_version: result.assessment.version },
    });
  }

  await step.run("flush-telemetry", () => flushTelemetry());
  return { status: "ok", assessment_version: result.assessment.version };
}

/** Find a case by id alone via the store's service-path lookup. */
async function findCaseById(store: PlannerStore, caseId: string) {
  if (store.getCaseByIdOnly) return store.getCaseByIdOnly(caseId);
  throw new Error("store cannot resolve case without org_id");
}

function defaultDeps(step: AssessmentStepTools): AssessmentDeps {
  const store = new SupabasePlannerStore();
  return {
    store,
    project: defaultProjector,
    clock: systemClock,
    step,
  };
}

export const caseAssessmentFunction = inngest.createFunction(
  {
    id: "case-assessment",
    triggers: [{ event: "case.assessment.requested" }],
    concurrency: [{ key: "event.data.case_id", limit: 1 }],
  },
  async ({ event, step }) =>
    runCaseAssessment(
      defaultDeps(step as unknown as AssessmentStepTools),
      event.data as { case_id: string; source_version?: number },
    ),
);
