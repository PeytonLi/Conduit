import { describe, expect, it } from "vitest";
import { planStepSchema, type PlanStep } from "@/lib/domain/plan-steps";
import { validatePlan } from "@/lib/domain/plans";
import type { QuoteEvaluation } from "@/lib/domain/quotes";
import { importedHarborProjection } from "./domain-test-helpers";

const baseline = importedHarborProjection();
const lines = {
  "line-1042": {
    remainingQty: 4_000,
    receiptIds: ["PO-1042-RECEIPT"],
    unitPriceMinor: 35n,
  },
};

function common(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    step_id: "step",
    kind: "amend_delivery_schedule",
    item_id: "CARTON-ITEM",
    quantity: 4_000,
    unit: "carton",
    destination_location_id: "MAIN-WAREHOUSE",
    depends_on_step_ids: [],
    evidence_ids: [],
    execution_mode: "demo_ledger",
    missing_fields: [],
    po_line_id: "line-1042",
    schedule: [
      { quantity: 600, earliest_at: null, latest_at: "2026-10-14T08:00:00-07:00", date_only: false },
      { quantity: 3_400, earliest_at: null, latest_at: "2026-10-16T08:00:00-07:00", date_only: false },
    ],
    added_freight_minor: 7_500n,
    supplier_confirmation_evidence_id: "amendment-evidence",
    ...overrides,
  } as PlanStep;
}

function planArgs(steps: PlanStep[], overrides: Partial<Parameters<typeof validatePlan>[0]> = {}) {
  return {
    target: "ready" as const,
    baseline,
    caseItemId: "CARTON-ITEM",
    caseLocationId: "MAIN-WAREHOUSE",
    lines,
    capabilities: { liveConnectorCanWrite: false },
    steps,
    ...overrides,
  };
}

function purchaseStep(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    step_id: "purchase",
    kind: "purchase_bridge",
    item_id: "CARTON-ITEM",
    quantity: 600,
    unit: "carton",
    destination_location_id: "MAIN-WAREHOUSE",
    depends_on_step_ids: [],
    evidence_ids: ["quote-evidence"],
    execution_mode: "demo_ledger",
    missing_fields: [],
    supplier_id: "north",
    contact_id: "contact",
    quote_id: "north-quote",
    quote_version: 1,
    arrival_window: { start: null, end: "2026-10-14T08:00:00-07:00" },
    landed_cost_minor: 31_200n,
    original_order_disposition: "unchanged",
    ...overrides,
  } as PlanStep;
}

function feasibleQuote(): QuoteEvaluation {
  return {
    quoteId: "north-quote",
    outcome: "feasible",
    reasons: [],
    missingTerms: [],
    orderQty: 600,
    surplusQty: 0,
    landedCostMinor: 31_200n,
    surplusCostMinor: 0n,
    coversAllDeadlines: true,
    effectiveArrivalAt: "2026-10-14T15:00:00Z",
    writtenConfirmationEvidenceId: "written-quote",
  };
}

describe("recovery plan validation", () => {
  it("AT-10 validates a split amendment and its incremental freight", () => {
    const result = validatePlan(planArgs([common()]));
    expect(result.feasible).toBe(true);
    expect(result.ready).toBe(true);
    expect(result.finalBalance).toBe(3_400);
    expect(result.grossCommitmentMinor).toBe(7_500n);
    expect(result.incrementalCostMinor).toBe(7_500n);
    expect(result.surplus).toEqual({ quantity: 0, costMinor: 0n });
  });

  it("AT-18 validates an alternative purchase, surplus, and evidence-gated cancellation credit", () => {
    const quote = { evaluation: feasibleQuote(), unitPriceMinor: 42n };
    const purchase = purchaseStep();
    const original = validatePlan(planArgs([purchase], {
      quotes: { "north-quote": quote },
    }));
    expect(original.feasible).toBe(true);
    expect(original.finalBalance).toBe(4_000);
    expect(original.surplus).toEqual({ quantity: 600, costMinor: 25_200n });
    expect(original.grossCommitmentMinor).toBe(31_200n);
    expect(original.incrementalCostMinor).toBe(31_200n);

    const cancel = common({
      step_id: "cancel",
      kind: "cancel_original_quantity",
      quantity: 600,
      execution_mode: "manual",
      po_line_id: "line-1042",
      cancellation_quantity: 600,
      confirmed_credit_minor: 21_000n,
      cancellation_fee_minor: 0n,
      supplier_acceptance_evidence_id: "accepted-cancel",
    });
    const accepted = validatePlan(planArgs([
      purchase,
      cancel,
    ], { quotes: { "north-quote": quote } }));
    expect(accepted.feasible).toBe(true);
    expect(accepted.finalBalance).toBe(3_400);
    expect(accepted.incrementalCostMinor).toBe(10_200n);

    const unconfirmed = validatePlan(planArgs([
      purchase,
      common({
        step_id: "cancel",
        kind: "cancel_original_quantity",
        quantity: 600,
        execution_mode: "manual",
        po_line_id: "line-1042",
        cancellation_quantity: 600,
        confirmed_credit_minor: 21_000n,
        cancellation_fee_minor: 0n,
        supplier_acceptance_evidence_id: null,
      }),
    ], { quotes: { "north-quote": quote } }));
    expect(unconfirmed.incrementalCostMinor).toBe(31_200n);
    expect(unconfirmed.unconfirmedCreditsMinor).toBe(21_000n);
  });

  it("AT-11 rejects transfers that leave the source location short", () => {
    const sourceBase = {
      ...baseline,
      physicalQty: 500,
      receipts: [],
      demand: [{
        id: "source-demand",
        quantity: 450,
        requiredAt: "2026-10-13T15:00:00Z",
        certainty: "confirmed" as const,
        includedReservedQty: 0,
      }],
    };
    for (const quantity of [51, 600]) {
      const transfer = common({
        step_id: `transfer-${quantity}`,
        kind: "transfer_stock",
        quantity,
        execution_mode: "live_connector",
        source_location_id: "source-location",
        arrival_window: { start: null, end: "2026-10-14T08:00:00-07:00" },
        transfer_cost_minor: 0n,
        source_coverage_evidence: "stock-evidence",
      });
      const result = validatePlan(planArgs([transfer], {
        sourceLocations: { "source-location": sourceBase },
      }));
      expect(result.violations.map((violation) => violation.code)).toContain("source_coverage_insufficient");
      expect(result.executionBlockers).toContain("transfer_requires_live_connector");
      expect(result.executable).toBe(false);
    }
  });

  it("rejects schedule totals, dependency cycles, and multiple external financial steps", () => {
    const mismatch = validatePlan(planArgs([common({
      schedule: [{ quantity: 3_999, earliest_at: null, latest_at: "2026-10-16T08:00:00-07:00" }],
    })]));
    expect(mismatch.violations.map((violation) => violation.code)).toContain("schedule_total_mismatch");

    const cycle = validatePlan(planArgs([
      common({ step_id: "one", depends_on_step_ids: ["two"] }),
      common({ step_id: "two", depends_on_step_ids: ["one"] }),
    ]));
    expect(cycle.violations.map((violation) => violation.code)).toContain("dependency_cycle");

    const multiple = validatePlan(planArgs([
      common(),
      purchaseStep(),
    ], { quotes: { "north-quote": { evaluation: feasibleQuote(), unitPriceMinor: 42n } } }));
    expect(multiple.violations.map((violation) => violation.code)).toContain("multiple_external_financial_steps");
  });

  it("parses plan money wire strings to bigint using the Zod step contract", () => {
    const parsed = planStepSchema.parse({
      ...common(),
      added_freight_minor: "7500",
    });
    expect(parsed.kind).toBe("amend_delivery_schedule");
    if (parsed.kind === "amend_delivery_schedule") expect(parsed.added_freight_minor).toBe(7_500n);
  });
});
