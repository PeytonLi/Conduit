import { DomainValidationError } from "./errors";
import { projectInventory } from "./inventory";
import { incrementalCost, type QuoteEvaluation } from "./quotes";
import { MAX_MONEY_MINOR, mulQtyPrice, sumMinor } from "./money";
import { isQuantity } from "./quantity";
import { parseInstant } from "./time";
import type { ProjectionDiagnostics } from "./projection-types";
import type { ProjectionInput, ProjectionResult } from "./types";
import type { PlanStep } from "./plan-steps";

export type PlanValidation = {
  feasible: boolean;
  ready: boolean;
  executable: boolean;
  violations: { stepId: string | null; code: string; message: string }[];
  executionBlockers: string[];
  projection: ProjectionResult & ProjectionDiagnostics;
  baselineFinalBalance: number | null;
  finalBalance: number | null;
  surplus: { quantity: number; costMinor: bigint };
  grossCommitmentMinor: bigint;
  incrementalCostMinor: bigint;
  unconfirmedCreditsMinor: bigint;
};

type PlanLine = { remainingQty: number; receiptIds: string[]; unitPriceMinor: bigint };
type PlanArgs = {
  target: "draft" | "ready";
  baseline: ProjectionInput;
  caseItemId: string;
  caseLocationId: string;
  lines: Record<string, PlanLine>;
  sourceLocations?: Record<string, ProjectionInput>;
  quotes?: Record<string, { evaluation: QuoteEvaluation; unitPriceMinor: bigint }>;
  capabilities: { liveConnectorCanWrite: boolean };
  steps: PlanStep[];
};

function stepId(step: PlanStep): string {
  return step.step_id;
}

function requiredFields(step: PlanStep): unknown[] {
  const common = [step.item_id, step.quantity, step.unit, step.destination_location_id];
  switch (step.kind) {
    case "amend_delivery_schedule":
      return [...common, step.po_line_id, step.schedule, step.added_freight_minor, step.supplier_confirmation_evidence_id];
    case "purchase_bridge":
      return [...common, step.supplier_id, step.contact_id, step.quote_id, step.quote_version, step.arrival_window, step.landed_cost_minor, step.original_order_disposition];
    case "transfer_stock":
      return [...common, step.source_location_id, step.arrival_window, step.transfer_cost_minor, step.source_coverage_evidence];
    case "cancel_original_quantity":
      return [...common, step.po_line_id, step.cancellation_quantity, step.cancellation_fee_minor];
  }
}

function invalidMoney(value: bigint | null): boolean {
  return value !== null && (value < 0n || value > MAX_MONEY_MINOR);
}

function isFinancial(step: PlanStep): boolean {
  switch (step.kind) {
    case "purchase_bridge":
      return step.execution_mode !== "manual";
    case "transfer_stock":
      return step.transfer_cost_minor !== null && step.transfer_cost_minor > 0n && step.execution_mode !== "manual";
    case "amend_delivery_schedule":
      return step.added_freight_minor !== null && step.added_freight_minor > 0n && step.execution_mode !== "manual";
    case "cancel_original_quantity":
      return step.cancellation_fee_minor !== null && step.cancellation_fee_minor > 0n && step.execution_mode !== "manual";
  }
}

function detectCycles(steps: PlanStep[], violations: PlanValidation["violations"]): void {
  const byId = new Map<string, PlanStep>();
  for (const step of steps) {
    if (byId.has(step.step_id)) violations.push({ stepId: step.step_id, code: "duplicate_step_id", message: "Step IDs must be unique." });
    byId.set(step.step_id, step);
  }
  for (const step of steps) {
    for (const dependency of step.depends_on_step_ids) {
      if (!byId.has(dependency)) {
        violations.push({ stepId: step.step_id, code: "unknown_dependency", message: `Dependency ${dependency} does not exist.` });
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      violations.push({ stepId: id, code: "dependency_cycle", message: "Plan dependencies must be acyclic." });
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.depends_on_step_ids ?? []) {
      if (byId.has(dependency)) visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) visit(id);
}

function nonnegativeMoney(value: bigint | null): bigint {
  return value ?? 0n;
}

export function validatePlan(args: PlanArgs): PlanValidation {
  const violations: PlanValidation["violations"] = [];
  const executionBlockers: string[] = [];
  const steps = args.steps;
  detectCycles(steps, violations);

  for (const step of steps) {
    if (step.item_id !== args.caseItemId) violations.push({ stepId: stepId(step), code: "item_mismatch", message: "Step item must match the case item." });
    if (step.unit !== args.baseline.unit) violations.push({ stepId: stepId(step), code: "unit_mismatch", message: "Step unit must match the baseline unit." });
    if (step.destination_location_id !== args.caseLocationId) violations.push({ stepId: stepId(step), code: "destination_mismatch", message: "Step destination must match the case location." });
    if (step.quantity === null || !isQuantity(step.quantity)) violations.push({ stepId: stepId(step), code: "invalid_quantity", message: "Step quantity must be a supported nonnegative integer." });
    const moneyValues = step.kind === "amend_delivery_schedule"
      ? [step.added_freight_minor]
      : step.kind === "purchase_bridge"
        ? [step.landed_cost_minor]
        : step.kind === "transfer_stock"
          ? [step.transfer_cost_minor]
          : [step.confirmed_credit_minor, step.cancellation_fee_minor];
    if (moneyValues.some(invalidMoney)) {
      violations.push({ stepId: step.step_id, code: "out_of_range", message: "Plan amounts must be nonnegative supported minor-unit values." });
    }
    if (
      step.kind === "amend_delivery_schedule" &&
      args.target === "ready" &&
      step.schedule?.some((entry) => entry.quantity === null || entry.latest_at === null)
    ) {
      violations.push({ stepId: step.step_id, code: "not_ready", message: "Ready schedule entries require quantities and latest arrival times." });
    }
    if (args.target === "ready" && (step.missing_fields.length > 0 || requiredFields(step).some((field) => field === null || field === undefined))) {
      violations.push({ stepId: stepId(step), code: "not_ready", message: "Ready steps must have all required terms." });
    }
  }
  if (args.target === "ready" && steps.filter(isFinancial).length > 1) {
    violations.push({ stepId: null, code: "multiple_external_financial_steps", message: "At most one external financial step is allowed." });
  }
  if (steps.length > 1) {
    for (const step of steps) {
      if (step.kind === "cancel_original_quantity" && step.execution_mode !== "manual") {
        violations.push({ stepId: step.step_id, code: "cancel_must_be_manual", message: "Cancellation in a multi-step plan must be manual." });
      }
    }
  }

  const modified: ProjectionInput = {
    ...args.baseline,
    receipts: [...args.baseline.receipts],
    demand: [...args.baseline.demand],
    pendingClaims: [...args.baseline.pendingClaims],
  };
  let purchaseCost = 0n;
  let transferCost = 0n;
  let amendmentFees = 0n;
  let cancellationFees = 0n;
  let confirmedCredits = 0n;
  let unconfirmedCreditsMinor = 0n;
  let surplusUnitPrice = 0n;

  for (const step of steps) {
    if (step.kind === "amend_delivery_schedule") {
      const line = step.po_line_id === null ? undefined : args.lines[step.po_line_id];
      if (!line) {
        violations.push({ stepId: step.step_id, code: "unknown_po_line", message: "Purchase order line does not exist." });
        continue;
      }
      modified.receipts = modified.receipts.filter((receipt) => !line.receiptIds.includes(receipt.id));
      const schedule = step.schedule ?? [];
      const total = schedule.reduce((sum, entry) => sum + (entry.quantity ?? 0), 0);
      if ((args.target === "ready" || schedule.every((entry) => entry.quantity !== null)) && total !== line.remainingQty) {
        violations.push({ stepId: step.step_id, code: "schedule_total_mismatch", message: "Replacement schedule must equal the line's remaining quantity." });
      }
      schedule.forEach((entry, index) => {
        if (entry.quantity === null || !isQuantity(entry.quantity)) {
          violations.push({ stepId: step.step_id, code: "invalid_quantity", message: "Schedule quantities must be supported integers." });
        }
        if (entry.latest_at !== null && parseInstant(entry.latest_at) === null) {
          violations.push({ stepId: step.step_id, code: "invalid_schedule_time", message: "Schedule latest_at must include an offset." });
        }
        if (entry.earliest_at !== null && parseInstant(entry.earliest_at) === null) {
          violations.push({ stepId: step.step_id, code: "invalid_schedule_time", message: "Schedule earliest_at must include an offset." });
        }
        if (entry.quantity !== null) {
          modified.receipts.push({
            id: `${step.step_id}:${index}`,
            quantity: entry.quantity,
            earliestAt: entry.earliest_at,
            latestAt: entry.latest_at,
            dateOnly: entry.date_only ?? false,
            promiseState: "confirmed",
            evidenceIds: step.supplier_confirmation_evidence_id ? [step.supplier_confirmation_evidence_id] : [],
          });
        }
      });
      amendmentFees += nonnegativeMoney(step.added_freight_minor);
    } else if (step.kind === "cancel_original_quantity") {
      const line = step.po_line_id === null ? undefined : args.lines[step.po_line_id];
      if (!line) {
        violations.push({ stepId: step.step_id, code: "unknown_po_line", message: "Purchase order line does not exist." });
        continue;
      }
      const quantity = step.cancellation_quantity;
      if (quantity === null && args.target === "draft") {
        cancellationFees += nonnegativeMoney(step.cancellation_fee_minor);
        if (step.confirmed_credit_minor !== null) {
          if (step.supplier_acceptance_evidence_id) confirmedCredits += step.confirmed_credit_minor;
          else unconfirmedCreditsMinor += step.confirmed_credit_minor;
        }
        continue;
      }
      if (quantity === null || !isQuantity(quantity) || quantity > line.remainingQty) {
        violations.push({ stepId: step.step_id, code: "cancellation_exceeds_remaining", message: "Cancellation exceeds the line's remaining quantity." });
        continue;
      }
      const lineReceipts = modified.receipts
        .filter((receipt) => line.receiptIds.includes(receipt.id))
        .sort((left, right) => (parseInstant(right.latestAt ?? "") ?? -Infinity) - (parseInstant(left.latestAt ?? "") ?? -Infinity));
      let remainingCancellation = quantity;
      for (const receipt of lineReceipts) {
        if (remainingCancellation === 0) break;
        const removed = Math.min(receipt.quantity, remainingCancellation);
        receipt.quantity -= removed;
        remainingCancellation -= removed;
      }
      if (remainingCancellation > 0) {
        violations.push({ stepId: step.step_id, code: "cancellation_exceeds_scheduled", message: "Scheduled receipts do not cover the cancellation quantity." });
      }
      modified.receipts = modified.receipts.filter((receipt) => receipt.quantity > 0);
      cancellationFees += nonnegativeMoney(step.cancellation_fee_minor);
      if (step.confirmed_credit_minor !== null) {
        if (step.supplier_acceptance_evidence_id) confirmedCredits += step.confirmed_credit_minor;
        else unconfirmedCreditsMinor += step.confirmed_credit_minor;
      }
    } else if (step.kind === "purchase_bridge") {
      const quote = step.quote_id === null ? undefined : args.quotes?.[step.quote_id];
      if (quote) surplusUnitPrice = quote.unitPriceMinor;
      if (args.target === "ready" && (!quote || quote.evaluation.outcome !== "feasible")) {
        violations.push({ stepId: step.step_id, code: "quote_not_feasible", message: "A ready bridge purchase requires a feasible quote." });
      }
      if (
        quote &&
        step.landed_cost_minor !== null &&
        quote.evaluation.landedCostMinor !== null &&
        step.landed_cost_minor !== quote.evaluation.landedCostMinor
      ) {
        violations.push({ stepId: step.step_id, code: "landed_cost_mismatch", message: "Step landed cost must match the evaluated quote." });
      }
      const arrival = step.arrival_window?.end ?? null;
      const arrivalStart = step.arrival_window?.start ?? null;
      if (
        step.quantity !== null &&
        arrival !== null &&
        parseInstant(arrival) !== null &&
        (arrivalStart === null || parseInstant(arrivalStart) !== null)
      ) {
        modified.receipts.push({
          id: `${step.step_id}:purchase`,
          quantity: step.quantity,
          earliestAt: arrivalStart,
          latestAt: arrival,
          dateOnly: false,
          promiseState: "confirmed",
          evidenceIds: step.evidence_ids,
        });
      } else if (args.target === "ready" || (arrival !== null && parseInstant(arrival) === null) || (arrivalStart !== null && parseInstant(arrivalStart) === null)) {
        violations.push({ stepId: step.step_id, code: "invalid_arrival_window", message: "Purchase arrival window end must include an offset." });
      }
      purchaseCost += nonnegativeMoney(step.landed_cost_minor);
    } else if (step.kind === "transfer_stock") {
      const arrival = step.arrival_window?.end ?? null;
      const arrivalStart = step.arrival_window?.start ?? null;
      if (
        step.quantity !== null &&
        arrival !== null &&
        parseInstant(arrival) !== null &&
        (arrivalStart === null || parseInstant(arrivalStart) !== null)
      ) {
        modified.receipts.push({
          id: `${step.step_id}:transfer`,
          quantity: step.quantity,
          earliestAt: arrivalStart,
          latestAt: arrival,
          dateOnly: false,
          promiseState: "confirmed",
          evidenceIds: step.source_coverage_evidence ? [step.source_coverage_evidence] : [],
        });
      } else if (args.target === "ready" || (arrival !== null && parseInstant(arrival) === null) || (arrivalStart !== null && parseInstant(arrivalStart) === null)) {
        violations.push({ stepId: step.step_id, code: "invalid_arrival_window", message: "Transfer arrival window end must include an offset." });
      }
      const source = step.source_location_id === null ? undefined : args.sourceLocations?.[step.source_location_id];
      if (!source) {
        violations.push({ stepId: step.step_id, code: "missing_source_location", message: "Transfer source projection is missing." });
      } else if (step.quantity !== null) {
        const sourceProjection = projectInventory({
          ...source,
          demand: [
            ...source.demand,
            {
              id: `${step.step_id}:transfer-demand`,
              quantity: step.quantity,
              requiredAt: source.t0,
              certainty: "confirmed",
              includedReservedQty: 0,
            },
          ],
        });
        if (sourceProjection.quality !== "sufficient" || (sourceProjection.bridgeQuantity ?? 0) > 0) {
          violations.push({ stepId: step.step_id, code: "source_coverage_insufficient", message: "Transfer would leave the source location uncovered." });
        }
      }
      if (!args.capabilities.liveConnectorCanWrite) executionBlockers.push("transfer_requires_live_connector");
      transferCost += nonnegativeMoney(step.transfer_cost_minor);
    }
  }

  const projection = projectInventory(modified);
  const baselineProjection = projectInventory(args.baseline);
  try {
    unconfirmedCreditsMinor = sumMinor(unconfirmedCreditsMinor);
  } catch (error) {
    if (!(error instanceof DomainValidationError)) throw error;
    violations.push({ stepId: null, code: error.code, message: "Unconfirmed credits exceed supported limits." });
    unconfirmedCreditsMinor = 0n;
  }
  const feasible =
    violations.length === 0 &&
    projection.quality === "sufficient" &&
    projection.bridgeQuantity === 0;
  const finalBalance = projection.finalBalance;
  const baselineFinalBalance = baselineProjection.finalBalance;
  const surplusQuantity =
    finalBalance === null || baselineFinalBalance === null
      ? 0
      : Math.max(0, finalBalance - baselineFinalBalance);
  let surplusCostMinor: bigint;
  try {
    surplusCostMinor = mulQtyPrice(surplusQuantity, surplusUnitPrice);
  } catch (error) {
    if (error instanceof DomainValidationError) {
      violations.push({ stepId: null, code: error.code, message: "Surplus cost exceeds supported limits." });
    }
    surplusCostMinor = 0n;
  }
  let grossCommitmentMinor: bigint;
  try {
    grossCommitmentMinor = sumMinor(purchaseCost, transferCost, amendmentFees, cancellationFees);
  } catch (error) {
    if (!(error instanceof DomainValidationError)) throw error;
    violations.push({ stepId: null, code: error.code, message: "Plan commitment exceeds supported limits." });
    grossCommitmentMinor = 0n;
  }
  let incrementalCostMinor: bigint;
  try {
    incrementalCostMinor = incrementalCost({
      newRecoveryCostMinor: purchaseCost + transferCost,
      originalOrderChangeFeesMinor: amendmentFees + cancellationFees,
      confirmedOriginalOrderCreditsMinor: confirmedCredits,
    });
  } catch (error) {
    if (error instanceof DomainValidationError) {
      violations.push({ stepId: null, code: error.code, message: "Plan cost exceeds supported limits." });
      incrementalCostMinor = 0n;
    } else {
      throw error;
    }
  }

  const ready = args.target === "ready" && feasible;
  return {
    feasible,
    ready,
    executable: feasible && ready && executionBlockers.length === 0,
    violations,
    executionBlockers: [...new Set(executionBlockers)],
    projection,
    baselineFinalBalance,
    finalBalance,
    surplus: { quantity: surplusQuantity, costMinor: surplusCostMinor },
    grossCommitmentMinor,
    incrementalCostMinor,
    unconfirmedCreditsMinor,
  };
}
