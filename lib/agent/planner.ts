import type { AgentTool, AgentToolContext, ToolResult } from "./tools/types";
import type { Clock } from "./clock";
import type { PlannerModel, ModelCallError } from "./model";
import type { PlannerStore, UsageEventInput } from "./store";
import { DEFAULT_LIMITS, type PlannerLimits } from "./budgets";
import { allowedTools, toolAllowed } from "./phases";
import { buildPlannerContext } from "./context";
import { parseModelTurn } from "./decision";
import { PLANNER_SYSTEM_PROMPT, PROMPT_VERSION } from "./prompt";
import { canonicalJson } from "./canonical-json";
import { toolInputToJsonSchema } from "./tool-schema";
import { withBusinessSpan, orgPseudonym } from "@/lib/telemetry";

export interface StepTools {
  run<T>(id: string, fn: () => Promise<T> | T): Promise<T>;
  sleep(id: string, ms: number | string): Promise<void>;
}

export interface PlannerDeps {
  model: PlannerModel;
  tools: Map<string, AgentTool<unknown, unknown>> | Record<string, AgentTool<unknown, unknown>>;
  store: PlannerStore;
  clock: Clock;
  step: StepTools;
  limits?: PlannerLimits;
}

export interface CycleOutcome {
  status: "waiting" | "needs_review" | "plan_proposed" | "no_action" | "blocked";
  blockReason?: "budget_exhausted" | "provider_unavailable";
  modelRequests: number;
}

type ToolMap = Map<string, AgentTool<unknown, unknown>>;

function toMap(
  tools: PlannerDeps["tools"],
): ToolMap {
  return tools instanceof Map ? tools : new Map(Object.entries(tools));
}

const SUMMARY_CAP = 2_000;

async function raiseReview(
  deps: PlannerDeps,
  orgId: string,
  caseId: string,
  reason: string,
  missingFields: string[] = [],
  objectIds: string[] = [],
): Promise<void> {
  await deps.store.insertReview({
    org_id: orgId,
    case_id: caseId,
    reason: reason.slice(0, 500),
    missing_fields: missingFields.slice(0, 20),
    object_ids: objectIds.slice(0, 20),
    status: "open",
    created_by: "planner",
  });
}

export async function runPlannerCycle(
  deps: PlannerDeps,
  ctx: AgentToolContext & {
    episode: number;
    assessmentVersion: number;
    cycleId: string;
    cycleIndex?: number;
  },
): Promise<CycleOutcome> {
  const { store, step, clock } = deps;
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const tools = toMap(deps.tools);
  const { orgId, caseId, episode } = ctx;
  const ck = `c${ctx.cycleIndex ?? 0}`;
  const summaries: string[] = [];
  let modelRequests = 0;
  const seenCalls = new Set<string>();
  let disallowedCount = 0;

  // Cycle row at start — inside a step with the deterministic cycleId so an
  // Inngest replay reuses the existing row instead of inserting a second one.
  const cycle = await step.run(`${ck}-cycle-start`, () =>
    store.insertCycle({
      id: ctx.cycleId,
      org_id: orgId,
      case_id: caseId,
      episode,
      assessment_version: ctx.assessmentVersion,
      status: "running",
      block_reason: null,
      model_requests: 0,
      prompt_version: PROMPT_VERSION,
      started_at: clock.now().toISOString(),
      ended_at: null,
    }),
  );

  const recordUsage = async (
    usage: {
      request_id: string;
      model: string;
      raw_units: Record<string, number>;
      estimated_cost: string | null;
      actual_cost: string | null;
      billing_currency: "USD" | null;
      rate_version: string | null;
    },
  ): Promise<void> => {
    if (Object.keys(usage.raw_units).length === 0) return;
    const input: UsageEventInput = {
      orgId,
      caseId,
      provider: "deepseek",
      requestId: usage.request_id,
      chargeType: "planner_inference",
      model: usage.model,
      rawUnits: usage.raw_units,
      estimatedCost: usage.estimated_cost,
      actualCost: usage.actual_cost,
      billingCurrency: usage.billing_currency,
      rateVersion: usage.rate_version,
    };
    await store.insertUsageEvent(input);
  };

  const finish = async (
    outcome: CycleOutcome,
  ): Promise<CycleOutcome> => {
    await step.run(`${ck}-cycle-finish`, () =>
      store.updateCycle(orgId, cycle.id, {
        status: outcome.status,
        block_reason: outcome.blockReason ?? null,
        model_requests: modelRequests,
        ended_at: clock.now().toISOString(),
      }),
    );
    return outcome;
  };

  for (let n = 0; n < limits.modelRequestsPerCycle + limits.providerRetries + 2; n++) {
    // 1. budget check
    const exhausted = await step.run(`${ck}-budget-check-${n}`, async () => {
      const cycleCount = await store.countPlannerRequests(
        orgId,
        caseId,
        episode,
        cycle.id,
      );
      const episodeCount = await store.countPlannerRequests(
        orgId,
        caseId,
        episode,
      );
      return (
        cycleCount >= limits.modelRequestsPerCycle ||
        episodeCount >= limits.modelRequestsPerEpisode
      );
    });
    if (exhausted) {
      await step.run(`${ck}-budget-review-${n}`, () =>
        raiseReview(deps, orgId, caseId, "model budget exhausted"),
      );
      return finish({ status: "blocked", blockReason: "budget_exhausted", modelRequests });
    }

    // 2. inference (with provider retries)
    const caseRow = await step.run(`${ck}-case-${n}`, () => store.getCase(orgId, caseId));
    if (!caseRow) {
      return finish({ status: "no_action", modelRequests });
    }

    let attempt = 0;
    let turn: Awaited<ReturnType<PlannerModel["complete"]>> | null = null;
    let lastError: ModelCallError | null = null;

    while (attempt <= limits.providerRetries) {
      const kind =
        attempt === 0 ? ("inference" as const) : ("retry" as const);
      const result = await step.run(`${ck}-infer-${n}-${attempt}`, async () => {
        const context = await buildPlannerContext(store, ctx, clock, limits);
        const messages = [
          { role: "system" as const, content: PLANNER_SYSTEM_PROMPT },
          { role: "user" as const, content: JSON.stringify(context) },
          ...summaries.map(
            (s) =>
              ({
                role: "user" as const,
                content: s.slice(0, SUMMARY_CAP),
              }),
          ),
        ];
        const toolDefs = allowedTools(caseRow.phase)
          .map((name) => tools.get(name))
          .filter((t): t is AgentTool<unknown, unknown> => Boolean(t))
          .map((t) => ({
            name: t.name,
            description: t.description,
            parameters: toolInputToJsonSchema(t.input),
          }));
        // Persisted episode request count determines the replay cursor so a
        // rebuilt replay model resumes at the right transcript entry.
        const sequence = await store.countPlannerRequests(orgId, caseId, episode);
        try {
          const modelTurn = await withBusinessSpan(
            "planner_inference",
            {
              org_pseudonym: orgPseudonym(orgId),
              case_id: caseId,
              episode,
              assessment_version: ctx.assessmentVersion,
              prompt_version: PROMPT_VERSION,
            },
            () => deps.model.complete({ messages, tools: toolDefs, sequence }),
          );
          await store.insertPlannerRequest({
            org_id: orgId,
            case_id: caseId,
            cycle_id: cycle.id,
            episode,
            kind,
            outcome: "ok",
            provider: "deepseek",
            provider_request_id: modelTurn.providerRequestId,
            model: modelTurn.model,
            prompt_version: PROMPT_VERSION,
            estimated_cost: modelTurn.usage.estimated_cost,
          });
          await recordUsage(modelTurn.usage);
          return { ok: true as const, turn: modelTurn };
        } catch (error) {
          const kind2 = (error as ModelCallError).kind ?? "server_error";
          await store.insertPlannerRequest({
            org_id: orgId,
            case_id: caseId,
            cycle_id: cycle.id,
            episode,
            kind,
            outcome: kind2,
            provider: "deepseek",
            provider_request_id: null,
            model: null,
            prompt_version: PROMPT_VERSION,
            estimated_cost: null,
          });
          return { ok: false as const, error };
        }
      });
      modelRequests += 1;
      if (result.ok) {
        turn = result.turn;
        break;
      }
      lastError = result.error as ModelCallError;
      const retryable =
        lastError.kind === "rate_limited" ||
        lastError.kind === "timeout" ||
        lastError.kind === "server_error";
      if (!retryable || attempt >= limits.providerRetries) break;
      const backoff =
        lastError.retryAfterMs !== undefined
          ? lastError.retryAfterMs
          : 2000 * 2 ** attempt;
      await step.sleep(`${ck}-backoff-${n}-${attempt}`, backoff);
      attempt += 1;
    }

    if (!turn) {
      await step.run(`${ck}-provider-review-${n}`, () =>
        raiseReview(
          deps,
          orgId,
          caseId,
          `model provider unavailable (${lastError?.kind ?? "unknown"})`,
        ),
      );
      return finish({
        status: "blocked",
        blockReason: "provider_unavailable",
        modelRequests,
      });
    }

    // 3. parse
    let parsed = parseModelTurn(turn);
    if (!parsed.ok) {
      const issues = parsed.issues;
      // Exactly one repair inference.
      const repairResult = await step.run(`${ck}-repair-${n}`, async () => {
        const context = await buildPlannerContext(store, ctx, clock, limits);
        const messages = [
          { role: "system" as const, content: PLANNER_SYSTEM_PROMPT },
          { role: "user" as const, content: JSON.stringify(context) },
          {
            role: "user" as const,
            content: `Your previous output was invalid: ${issues}. Reply with one valid decision JSON or one tool call.`,
          },
        ];
        const sequence = await store.countPlannerRequests(orgId, caseId, episode);
        try {
          const repairTurn = await deps.model.complete({ messages, tools: [], sequence });
          await store.insertPlannerRequest({
            org_id: orgId,
            case_id: caseId,
            cycle_id: cycle.id,
            episode,
            kind: "repair",
            outcome: "ok",
            provider: "deepseek",
            provider_request_id: repairTurn.providerRequestId,
            model: repairTurn.model,
            prompt_version: PROMPT_VERSION,
            estimated_cost: repairTurn.usage.estimated_cost,
          });
          await recordUsage(repairTurn.usage);
          return { ok: true as const, turn: repairTurn };
        } catch (error) {
          const kind2 = (error as ModelCallError).kind ?? "server_error";
          await store.insertPlannerRequest({
            org_id: orgId,
            case_id: caseId,
            cycle_id: cycle.id,
            episode,
            kind: "repair",
            outcome: kind2,
            provider: "deepseek",
            provider_request_id: null,
            model: null,
            prompt_version: PROMPT_VERSION,
            estimated_cost: null,
          });
          return { ok: false as const, error };
        }
      });
      modelRequests += 1;
      if (!repairResult.ok) {
        const kind2 = (repairResult.error as ModelCallError).kind ?? "server_error";
        await step.run(`${ck}-repair-provider-review-${n}`, () =>
          raiseReview(
            deps,
            orgId,
            caseId,
            `model provider unavailable during repair (${kind2})`,
          ),
        );
        return finish({
          status: "blocked",
          blockReason: "provider_unavailable",
          modelRequests,
        });
      }
      const reparsed = parseModelTurn(repairResult.turn);
      if (!reparsed.ok) {
        await step.run(`${ck}-invalid-review-${n}`, () =>
          raiseReview(deps, orgId, caseId, "invalid model output", [
            "valid_decision",
          ]),
        );
        return finish({ status: "needs_review", modelRequests });
      }
      parsed = reparsed;
    }

    const decision = parsed.decision;

    if (decision.decision_type === "no_action") {
      return finish({ status: "no_action", modelRequests });
    }

    // Map decision payloads to the corresponding tools.
    let toolName: string;
    let toolArgs: Record<string, unknown>;
    if (decision.decision_type === "tool_request") {
      const payload = decision.payload as {
        tool_name: string;
        arguments: Record<string, unknown>;
      };
      toolName = payload.tool_name;
      toolArgs = payload.arguments;
    } else if (decision.decision_type === "wait") {
      toolName = "wait_for_evidence";
      toolArgs = decision.payload;
    } else if (decision.decision_type === "request_review") {
      toolName = "request_owner_review";
      toolArgs = decision.payload;
    } else {
      toolName = "propose_recovery_plan";
      toolArgs = decision.payload;
    }

    // Loop guard: identical tool+args twice in one cycle.
    const callKey = `${toolName}:${canonicalJson(toolArgs)}`;
    if (seenCalls.has(callKey)) {
      await step.run(`${ck}-loop-review-${n}`, () =>
        raiseReview(deps, orgId, caseId, `repeated tool request: ${toolName}`),
      );
      return finish({ status: "needs_review", modelRequests });
    }
    seenCalls.add(callKey);

    // 5. tool execution
    const toolResult = await step.run(`${ck}-tool-${n}`, async (): Promise<ToolResult<unknown>> => {
      const tool = tools.get(toolName);
      if (!tool || !toolAllowed(caseRow.phase, toolName)) {
        return { ok: false, code: "tool_not_allowed", safeMessage: "tool not allowed in this phase" };
      }
      const validated = tool.input.safeParse(toolArgs);
      if (!validated.success) {
        return {
          ok: false,
          code: "invalid_arguments",
          safeMessage: validated.error.issues
            .slice(0, 5)
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
        };
      }
      const spanName = (tool as unknown as { spanName?: import("@/lib/telemetry").BusinessSpanName }).spanName ?? "matching";
      return withBusinessSpan(
        spanName,
        {
          org_pseudonym: orgPseudonym(orgId),
          case_id: caseId,
          episode,
          assessment_version: ctx.assessmentVersion,
          prompt_version: PROMPT_VERSION,
        },
        () => tool.run(ctx, validated.data),
        { safeInput: { tool: toolName } },
      );
    });

    if (!toolResult.ok && toolResult.code === "tool_not_allowed") {
      disallowedCount += 1;
      summaries.push(`tool ${toolName}: tool_not_allowed`);
      if (disallowedCount >= 2) {
        await step.run(`${ck}-disallowed-review-${n}`, () =>
          raiseReview(deps, orgId, caseId, "repeated disallowed tool requests"),
        );
        return finish({ status: "needs_review", modelRequests });
      }
      continue;
    }

    if (!toolResult.ok) {
      summaries.push(
        `tool ${toolName} failed: ${toolResult.code} — ${toolResult.safeMessage}`,
      );
      continue;
    }

    // Terminal tools.
    if (toolName === "wait_for_evidence") {
      return finish({ status: "waiting", modelRequests });
    }
    if (toolName === "request_owner_review") {
      return finish({ status: "needs_review", modelRequests });
    }
    if (toolName === "propose_recovery_plan") {
      return finish({ status: "plan_proposed", modelRequests });
    }

    summaries.push(
      `tool ${toolName} ok: ${JSON.stringify(toolResult.data).slice(0, SUMMARY_CAP)}`,
    );
  }

  await step.run(`${ck}-exhausted-review`, () =>
    raiseReview(deps, orgId, caseId, "model budget exhausted"),
  );
  return finish({ status: "blocked", blockReason: "budget_exhausted", modelRequests });
}
