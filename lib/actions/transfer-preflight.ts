import { buildProjectionInput, type ProjectionFacts } from "@/lib/domain/assessment-input";
import { checkTransferCoverage } from "@/lib/domain/transfers";
import { transferStockPayloadSchema } from "@/lib/integrations/business/transfer";
import { getTransferGate } from "./live-step";
import type { LedgerFailure, Rpc } from "./rpc";

interface PlanStepLike {
  step_id: string;
  kind: string;
  quantity: number | null;
  item_id?: string;
  destination_location_id?: string;
  execution_mode: "demo_ledger" | "live_connector" | "manual";
  payload: Record<string, unknown>;
}

/**
 * Deterministic checks that run before a plan containing a transfer is stored. A transfer that
 * would leave its source short is refused even as a recommendation (AT-11), and a transfer that
 * asks for live execution is refused when the connected system cannot execute it. Everything
 * else about the plan is validated by plan_create in the database.
 */
export async function preflightTransferSteps(
  deps: { rpc: Rpc },
  orgId: string,
  steps: PlanStepLike[],
): Promise<LedgerFailure | null> {
  for (const step of steps) {
    if (step.kind !== "transfer_stock") continue;
    const terms = transferStockPayloadSchema.safeParse({ change_kind: "transfer_stock", ...step.payload });
    if (!terms.success || !step.item_id || !step.destination_location_id || !step.quantity) {
      return { ok: false, code: "validation_failed", message: `Step ${step.step_id} is not a complete stock transfer` };
    }
    if (terms.data.source_location_id === step.destination_location_id) {
      return { ok: false, code: "validation_failed", message: `Step ${step.step_id}: the source must differ from the destination` };
    }

    const facts = (await deps.rpc("load_projection_facts", {
      p_org_id: orgId,
      p_item_id: step.item_id,
      p_location_id: terms.data.source_location_id,
    })) as ProjectionFacts;
    const { input: source } = buildProjectionInput(facts);
    if (!source) {
      return {
        ok: false,
        code: "validation_failed",
        message: `Step ${step.step_id}: the source location's stock for this item is not known`,
        reason: "source_facts_incomplete",
      };
    }
    const coverage = checkTransferCoverage(source, step.quantity, step.step_id);
    if (!coverage.ok) {
      return {
        ok: false,
        code: "validation_failed",
        message:
          coverage.code === "source_coverage_insufficient"
            ? `Step ${step.step_id}: the source can spare at most ${coverage.maxSafeQuantity} without running short itself`
            : `Step ${step.step_id}: the source's stock cannot be confirmed`,
        reason: coverage.code,
        max_safe_quantity: coverage.maxSafeQuantity,
      };
    }

    if (step.execution_mode === "live_connector") {
      const gate = getTransferGate();
      const status = gate ? await gate(orgId) : null;
      if (!status || status.mode !== "execute") {
        return {
          ok: false,
          code: "unsupported_step",
          message: `Step ${step.step_id} cannot run in the business system: ${status?.reason ?? "no business system connector is available"}. Create it as a manual step instead.`,
          reason: status?.mode === "recommend_only" ? status.code : "no_connector",
        };
      }
    }
  }
  return null;
}
