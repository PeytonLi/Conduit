import { describe, expect, it } from "vitest";
import { assessInventory } from "@/lib/domain/assessment";
import { buildProjectionInput, type ProjectionFacts } from "@/lib/domain/assessment-input";
import { baseProjection } from "./domain-test-helpers";

describe("inventory assessment", () => {
  it("AT-02 marks stale live sources insufficient and blocks live commitments", () => {
    const t0 = "2026-10-12T15:00:00Z";
    const result = assessInventory(baseProjection({ t0 }), {
      now: "2026-10-12T15:16:00Z",
      mode: "live",
      itemBaseUnit: "carton",
      sources: [{ kind: "inventory", id: "stock-1", sourceAsOf: t0 }],
      sourceType: "connector",
    });
    expect(result.projection.quality).toBe("insufficient");
    expect(result.projection.missingFacts).toContain("stale:inventory:stock-1");
    expect(result.projection.bridgeQuantity).toBeNull();
    expect(result.liveCommitmentAllowed).toBe(false);
    expect(result.staleSources).toEqual(["stale:inventory:stock-1"]);
  });

  it("AT-02 reports stale sources without downgrading replay or sandbox projections", () => {
    const t0 = "2026-10-12T15:00:00Z";
    for (const mode of ["replay", "sandbox"] as const) {
      const result = assessInventory(baseProjection({ t0 }), {
        now: "2026-10-12T15:16:00Z",
        mode,
        itemBaseUnit: "carton",
        sources: [{ kind: "inventory", id: "stock-1", sourceAsOf: t0 }],
        sourceType: "connector",
      });
      expect(result.projection.quality).toBe("sufficient");
      expect(result.staleSources).toEqual(["stale:inventory:stock-1"]);
      expect(result.missingFacts).not.toContain("stale:inventory:stock-1");
      expect(result.liveCommitmentAllowed).toBe(false);
    }
  });

  it("AT-02 keeps future-dated and invalid source timestamps insufficient in every mode", () => {
    const input = baseProjection();
    for (const mode of ["replay", "sandbox", "live"] as const) {
      const future = assessInventory(input, {
        now: input.t0,
        mode,
        itemBaseUnit: "carton",
        sources: [{ kind: "inventory", id: "stock-1", sourceAsOf: "2026-10-12T15:01:00Z" }],
      });
      expect(future.projection.quality).toBe("insufficient");
      expect(future.missingFacts).toContain("contradictory:source_as_of_in_future:inventory:stock-1");

      const invalid = assessInventory(input, {
        now: input.t0,
        mode,
        itemBaseUnit: "carton",
        sources: [{ kind: "inventory", id: "stock-1", sourceAsOf: "2026-10-12T15:00:00" }],
      });
      expect(invalid.projection.quality).toBe("insufficient");
      expect(invalid.missingFacts).toContain("invalid:source_as_of:inventory:stock-1");
    }
  });

  it("AT-02 rejects unit mismatches and never allows CSV data for live commitment", () => {
    const input = baseProjection();
    const unitMismatch = assessInventory(input, {
      now: input.t0,
      mode: "live",
      itemBaseUnit: "case",
      sources: [{ kind: "inventory", id: "stock-1", sourceAsOf: input.t0 }],
      sourceType: "connector",
    });
    expect(unitMismatch.missingFacts).toContain("unit_mismatch:carton!=case");
    expect(unitMismatch.projection.quality).toBe("insufficient");

    const csv = assessInventory(input, {
      now: input.t0,
      mode: "live",
      itemBaseUnit: "carton",
      sources: [{ kind: "inventory", id: "stock-1", sourceAsOf: input.t0 }],
      sourceType: "csv",
    });
    expect(csv.projection.quality).toBe("sufficient");
    expect(csv.liveCommitmentAllowed).toBe(false);
  });

  it("builds projection facts without manufacturing missing inventory or default quantities", () => {
    const emptyFacts: ProjectionFacts = {
      dataset: null,
      item: null,
      location: null,
      inventory: null,
      demand: [],
      receipts: [],
      lines: [],
      claims: [],
    };
    const missing = buildProjectionInput(emptyFacts);
    expect(missing.input).toBeNull();
    expect(missing.missingFacts).toEqual([
      "missing:active_dataset",
      "missing:item",
      "missing:location",
      "missing:inventory_snapshot",
    ]);

    const facts: ProjectionFacts = {
      dataset: {
        id: "dataset-1",
        source_type: "csv",
        source_as_of: "2026-10-12T15:00:00Z",
        content_hash: "hash",
      },
      item: { id: "item-1", base_unit: "carton", specification: {} },
      location: { id: "location-1", timezone: "America/Los_Angeles" },
      inventory: {
        id: "snapshot-1",
        physical_qty: 25,
        unusable_qty: 2,
        outside_allocations_qty: 3,
        source_as_of: "2026-10-12T15:00:00Z",
      },
      demand: [{
        id: "demand-1",
        external_id: "ORDER-1",
        remaining_qty: 10,
        required_at: "2026-10-13T15:00:00Z",
        certainty: "confirmed",
        included_reserved_qty: 4,
        source_as_of: "2026-10-12T15:00:00Z",
      }],
      receipts: [{
        id: "receipt-1",
        po_line_id: "line-1",
        quantity_remaining: 8,
        earliest_at: null,
        latest_at: "2026-10-14T15:00:00Z",
        promise_state: "confirmed",
        evidence_id: null,
        source_as_of: "2026-10-12T15:00:00Z",
      }],
      lines: [{
        id: "line-1",
        ordered_qty: 20,
        received_qty: 5,
        cancelled_qty: 2,
        unit_price_minor: "35",
      }],
      claims: [{ id: "claim-1", quantity: 1 }],
    };
    const built = buildProjectionInput(facts, { horizonDays: 30 });
    expect(built.input?.physicalQty).toBe(25);
    expect(built.input?.pendingClaims).toEqual([{ id: "claim-1", quantity: 1 }]);
    expect(built.input?.demand[0].id).toBe("demand-1");
    expect(built.context.sourceType).toBe("csv");
    expect(built.lines["line-1"]).toEqual({
      remainingQty: 13,
      receiptIds: ["receipt-1"],
      unitPriceMinor: 35n,
    });
  });
});
