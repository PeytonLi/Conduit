import { describe, expect, it } from "vitest";
import { createPlanRequestSchema } from "@/lib/actions/plans";
import { planStepSchema, type PlanStep } from "@/lib/domain/plan-steps";
import { validatePlan } from "@/lib/domain/plans";
import {
  checkTransferCoverage,
  maxSafeTransferQuantity,
  sourceSpareQuantity,
  transferCapabilityBlockers,
} from "@/lib/domain/transfers";
import type { ProjectionInput } from "@/lib/domain/types";
import { transferStockPayloadSchema } from "@/lib/integrations/business/transfer";
import { erpProviders } from "@/lib/integrations/business/live/registry";
import { erpTransferSupport, transferSupportFor } from "@/lib/integrations/business/live/transfer-support";

const T0 = "2030-01-10T00:00:00Z";
const HORIZON = "2030-02-09T00:00:00Z";

function stock(overrides: Partial<ProjectionInput> = {}): ProjectionInput {
  return {
    t0: T0,
    timezone: "UTC",
    unit: "each",
    horizonEnd: HORIZON,
    physicalQty: 500,
    unusableQty: 0,
    outsideAllocationsQty: 0,
    safetyBufferQty: 0,
    receipts: [],
    demand: [{ id: "own-demand", quantity: 450, requiredAt: "2030-01-13T15:00:00Z", certainty: "confirmed", includedReservedQty: 0 }],
    pendingClaims: [],
    ...overrides,
  };
}

describe("source coverage (AT-11)", () => {
  it("allows exactly what the source can spare and no more", () => {
    const source = stock();
    expect(maxSafeTransferQuantity(source)).toBe(50);
    expect(checkTransferCoverage(source, 50, "t")).toEqual({ ok: true, maxSafeQuantity: 50, sourceFloorQuantity: 450 });
    expect(checkTransferCoverage(source, 51, "t")).toEqual({ ok: false, code: "source_coverage_insufficient", maxSafeQuantity: 50 });
    expect(checkTransferCoverage(source, 600, "t")).toMatchObject({ ok: false, code: "source_coverage_insufficient" });
  });

  it("counts the source's own confirmed receipts, but not unconfirmed ones", () => {
    const receipt = (promiseState: "confirmed" | "estimated") => ({
      id: "inbound",
      quantity: 100,
      earliestAt: null,
      latestAt: "2030-01-11T12:00:00Z",
      dateOnly: false,
      promiseState,
      evidenceIds: [],
    });
    expect(maxSafeTransferQuantity(stock({ receipts: [receipt("confirmed")] }))).toBe(150);
    expect(maxSafeTransferQuantity(stock({ receipts: [receipt("estimated")] }))).toBe(50);
  });

  it("does not let a later receipt cover an earlier source demand", () => {
    const late = {
      id: "late",
      quantity: 1_000,
      earliestAt: null,
      latestAt: "2030-01-20T12:00:00Z",
      dateOnly: false,
      promiseState: "confirmed" as const,
      evidenceIds: [],
    };
    expect(maxSafeTransferQuantity(stock({ receipts: [late] }))).toBe(50);
  });

  it("subtracts unusable stock and quantity already claimed by another plan", () => {
    expect(maxSafeTransferQuantity(stock({ unusableQty: 20 }))).toBe(30);
    expect(maxSafeTransferQuantity(stock({ pendingClaims: [{ id: "other-plan", quantity: 30 }] }))).toBe(20);
  });

  it("offers nothing from a source that is already short", () => {
    const short = stock({ physicalQty: 100 });
    expect(maxSafeTransferQuantity(short)).toBe(0);
    expect(checkTransferCoverage(short, 1, "t")).toMatchObject({ ok: false, code: "source_coverage_insufficient", maxSafeQuantity: 0 });
  });

  it("refuses to promise anything when the source facts are incomplete", () => {
    const broken = stock({ demand: [{ id: "bad", quantity: 5, requiredAt: "not a time", certainty: "confirmed", includedReservedQty: 0 }] });
    expect(checkTransferCoverage(broken, 1, "t")).toEqual({ ok: false, code: "source_facts_incomplete", maxSafeQuantity: 0 });
    expect(maxSafeTransferQuantity(broken)).toBe(0);
  });

  it("rejects non-positive and over-precision quantities", () => {
    for (const quantity of [0, -1, 1.1234567, null]) {
      expect(checkTransferCoverage(stock(), quantity, "t")).toMatchObject({ ok: false, code: "invalid_quantity" });
    }
    expect(checkTransferCoverage(stock(), 1.5, "t").ok).toBe(true);
  });

  it("summarises a source's spare stock from projection facts", () => {
    const facts = {
      dataset: { id: "d", source_type: "connector" as const, source_as_of: T0, content_hash: "h" },
      item: { id: "i", base_unit: "each", specification: {} },
      location: { id: "l", timezone: "UTC" },
      inventory: { id: "inv", physical_qty: 500, unusable_qty: 0, outside_allocations_qty: 0, source_as_of: T0 },
      demand: [{ id: "d1", external_id: "d1", remaining_qty: 450, required_at: "2030-01-13T15:00:00Z", certainty: "confirmed" as const, included_reserved_qty: 0, source_as_of: T0 }],
      receipts: [],
      lines: [],
      claims: [],
    };
    expect(sourceSpareQuantity(facts)).toEqual({ ok: true, physicalQty: 500, maxSafeQuantity: 50 });
    expect(sourceSpareQuantity({ ...facts, inventory: null })).toEqual({ ok: false, reason: "source_facts_incomplete" });
  });
});

const destination = stock({
  physicalQty: 100,
  demand: [{ id: "dest-demand", quantity: 300, requiredAt: "2030-01-12T15:00:00Z", certainty: "confirmed", includedReservedQty: 0 }],
});

function transferStep(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    step_id: "transfer",
    kind: "transfer_stock",
    item_id: "ITEM",
    quantity: 50,
    unit: "each",
    destination_location_id: "DEST",
    depends_on_step_ids: [],
    evidence_ids: [],
    execution_mode: "live_connector",
    missing_fields: [],
    source_location_id: "SRC",
    arrival_window: { start: null, end: "2030-01-11T12:00:00Z" },
    transfer_cost_minor: 2_500n,
    source_coverage_evidence: "stock-evidence",
    ...overrides,
  } as PlanStep;
}

function args(steps: PlanStep[], overrides: Partial<Parameters<typeof validatePlan>[0]> = {}) {
  return {
    target: "ready" as const,
    baseline: destination,
    caseItemId: "ITEM",
    caseLocationId: "DEST",
    lines: {},
    sourceLocations: { SRC: stock() },
    capabilities: { liveConnectorCanWrite: true, transfer: { reserve: true, dispatch: true, receive: true } },
    steps,
    ...overrides,
  };
}

describe("transfer plan step validation", () => {
  it("covers a shortage from a source that can spare it, and is executable with a capable connector", () => {
    const smaller = { ...destination, demand: [{ ...destination.demand[0], quantity: 150 }] };
    const result = validatePlan(args([transferStep()], { baseline: smaller }));
    expect(result.violations).toEqual([]);
    expect(result.feasible).toBe(true);
    expect(result.ready).toBe(true);
    expect(result.executable).toBe(true);
    expect(result.executionBlockers).toEqual([]);
    expect(result.grossCommitmentMinor).toBe(2_500n);
  });

  it("is not feasible when the transfer arrives after the destination runs short", () => {
    const late = validatePlan(args([transferStep({ quantity: 50, arrival_window: { start: null, end: "2030-01-15T12:00:00Z" } })]));
    expect(late.feasible).toBe(false);
  });

  it("rejects a transfer that would shortchange the source, whatever the connector can do", () => {
    const result = validatePlan(args([transferStep({ quantity: 51 })]));
    expect(result.violations.map((v) => v.code)).toContain("source_coverage_insufficient");
    expect(result.feasible).toBe(false);
    expect(result.executable).toBe(false);
  });

  it("needs a source projection, and a source that differs from the destination", () => {
    expect(validatePlan(args([transferStep()], { sourceLocations: {} })).violations.map((v) => v.code)).toContain("missing_source_location");
    const same = validatePlan(args([transferStep({ source_location_id: "DEST" })], { sourceLocations: { DEST: stock() } }));
    expect(same.violations.map((v) => v.code)).toContain("source_equals_destination");
  });

  it("treats unknown timing or cost as an incomplete option", () => {
    const noTiming = validatePlan(args([transferStep({ arrival_window: { start: null, end: null } })]));
    expect(noTiming.ready).toBe(false);
    expect(noTiming.violations.map((v) => v.code)).toContain("invalid_arrival_window");
    const noCost = validatePlan(args([transferStep({ transfer_cost_minor: null })]));
    expect(noCost.ready).toBe(false);
    expect(noCost.violations.map((v) => v.code)).toContain("not_ready");
    expect(validatePlan(args([transferStep({ transfer_cost_minor: null })], { target: "draft" })).ready).toBe(false);
  });

  it("blocks execution unless the connector can reserve, dispatch and read back receiving", () => {
    expect(transferCapabilityBlockers({ reserve: true, dispatch: true, receive: true })).toEqual([]);
    expect(transferCapabilityBlockers(undefined)).toEqual([
      "transfer_unsupported_reserve",
      "transfer_unsupported_dispatch",
      "transfer_unsupported_receive",
    ]);
    const noDispatch = validatePlan(args([transferStep({ quantity: 10 })], { capabilities: { liveConnectorCanWrite: true, transfer: { reserve: true, dispatch: false, receive: true } } }));
    expect(noDispatch.executionBlockers).toEqual(["transfer_unsupported_dispatch"]);
    expect(noDispatch.executable).toBe(false);
    const readOnly = validatePlan(args([transferStep({ quantity: 10 })], { capabilities: { liveConnectorCanWrite: false } }));
    expect(readOnly.executionBlockers).toEqual(["transfer_requires_live_connector"]);
  });

  it("does not execute a step that was created as manual", () => {
    const result = validatePlan(args([transferStep({ quantity: 10, execution_mode: "manual" })]));
    expect(result.executionBlockers).toContain("transfer_step_not_live_connector");
    expect(result.executable).toBe(false);
  });

  it("parses the wire contract for a transfer step", () => {
    const parsed = planStepSchema.parse({ ...transferStep(), transfer_cost_minor: "2500" });
    expect(parsed.kind === "transfer_stock" && parsed.transfer_cost_minor).toBe(2_500n);
  });
});

describe("transfer support by provider", () => {
  it("declares every provider, and only Shopify executes", () => {
    expect(Object.keys(erpTransferSupport).sort()).toEqual([...erpProviders].sort());
    for (const provider of erpProviders) {
      const support = transferSupportFor(provider);
      if (provider === "shopify") {
        expect(support).toMatchObject({ mode: "execute", capabilities: { reserve: true, dispatch: true, receive: true } });
      } else {
        expect(support.mode).toBe("recommend_only");
        expect(support.mode === "recommend_only" && support.reason.length).toBeGreaterThan(20);
      }
    }
  });
});

describe("transfer plan request contract", () => {
  const SOURCE = "11111111-1111-4111-8111-111111111111";
  const body = (step: Record<string, unknown>) => ({
    assessment_id: "22222222-2222-4222-8222-222222222222",
    steps: [
      {
        step_id: "transfer-1",
        kind: "transfer_stock",
        item_id: "33333333-3333-4333-8333-333333333333",
        destination_location_id: "44444444-4444-4444-8444-444444444444",
        quantity: 40,
        execution_mode: "live_connector",
        payload: { source_location_id: SOURCE, arrival_end: "2030-01-12T17:00:00.000Z", transfer_cost_minor: "2500" },
        ...step,
      },
    ],
  });

  it("accepts a complete live or manual transfer", () => {
    expect(createPlanRequestSchema.safeParse(body({})).success).toBe(true);
    expect(createPlanRequestSchema.safeParse(body({ execution_mode: "manual" })).success).toBe(true);
  });

  it("rejects the demo ledger, missing terms, unknown timing and floats", () => {
    expect(createPlanRequestSchema.safeParse(body({ execution_mode: "demo_ledger" })).success).toBe(false);
    expect(createPlanRequestSchema.safeParse(body({ item_id: undefined })).success).toBe(false);
    expect(createPlanRequestSchema.safeParse(body({ quantity: 0 })).success).toBe(false);
    expect(createPlanRequestSchema.safeParse(body({ payload: { source_location_id: SOURCE, transfer_cost_minor: "2500" } })).success).toBe(false);
    expect(createPlanRequestSchema.safeParse(body({ payload: { source_location_id: SOURCE, arrival_end: "2030-01-12T17:00:00.000Z", transfer_cost_minor: "25.00" } })).success).toBe(false);
    expect(createPlanRequestSchema.safeParse(body({ payload: { source_location_id: SOURCE, arrival_end: "2030-01-12T17:00:00", transfer_cost_minor: "2500" } })).success).toBe(false);
  });

  it("does not let extra fields ride along in the approved terms", () => {
    expect(
      transferStockPayloadSchema.safeParse({
        change_kind: "transfer_stock",
        source_location_id: SOURCE,
        arrival_end: "2030-01-12T17:00:00.000Z",
        transfer_cost_minor: "0",
        approved: true,
      }).success,
    ).toBe(false);
  });
});
