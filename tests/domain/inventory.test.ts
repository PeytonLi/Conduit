import expected from "../fixtures/harbor-pack/expected.json";
import { describe, expect, it } from "vitest";
import { endOfLocalDate, parseInstant } from "@/lib/domain/time";
import { projectForecastScenario, projectInventory } from "@/lib/domain/inventory";
import { baseProjection, importedHarborProjection } from "./domain-test-helpers";

describe("inventory projection", () => {
  it("AT-01 matches the harbor CSV fixture and expected recovery deadlines", () => {
    const input = importedHarborProjection();
    const result = projectInventory(input);
    expect(result.firstShortageAt).toBe(expected.first_shortage_at);
    expect(result.bridgeQuantity).toBe(600);
    expect(result.bridgeQuantity).not.toBe(800);
    expect(result.bridgeQuantity).not.toBe(4_000);
    expect(result.requirements).toEqual([
      { by: expected.requirements[0].by, cumulativeQuantity: expected.requirements[0].cumulative_quantity },
      { by: expected.requirements[1].by, cumulativeQuantity: expected.requirements[1].cumulative_quantity },
    ]);

    const handBuilt = projectInventory(baseProjection({
      physicalQty: 600,
      receipts: [{
        id: "receipt",
        quantity: 4_000,
        earliestAt: "2026-10-16T15:00:00Z",
        latestAt: "2026-10-16T15:00:00Z",
        dateOnly: false,
        promiseState: "confirmed",
        evidenceIds: [],
      }],
      demand: [
        { id: "d1", quantity: 400, requiredAt: "2026-10-13T16:00:00Z", certainty: "confirmed", includedReservedQty: 0 },
        { id: "d2", quantity: 400, requiredAt: "2026-10-14T16:00:00Z", certainty: "confirmed", includedReservedQty: 0 },
        { id: "d3", quantity: 400, requiredAt: "2026-10-15T16:00:00Z", certainty: "confirmed", includedReservedQty: 0 },
      ],
    }));
    expect(handBuilt.firstShortageAt).toBe(result.firstShortageAt);
    expect(handBuilt.bridgeQuantity).toBe(result.bridgeQuantity);
    expect(handBuilt.requirements).toEqual(result.requirements);
  });

  it("AT-06 leaves included reservations as metadata and subtracts outside allocations once", () => {
    const demand = [{
      id: "included",
      quantity: 800,
      requiredAt: "2026-10-13T15:00:00Z",
      certainty: "confirmed" as const,
      includedReservedQty: 300,
    }];
    const included = projectInventory(baseProjection({ physicalQty: 1_000, demand }));
    expect(included.bridgeQuantity).toBe(0);
    expect(included.points.at(-1)?.balance).toBe(200);
    const outside = projectInventory(baseProjection({
      physicalQty: 1_000,
      outsideAllocationsQty: 300,
      demand,
    }));
    expect(outside.bridgeQuantity).toBe(100);
    expect(outside.usableStart).toBe(700);
  });

  it("AT-07 treats date-only receipts as end-of-day and handles both DST boundaries", () => {
    expect(endOfLocalDate("2026-11-01", "America/Los_Angeles")).toBe(
      parseInstant("2026-11-02T07:59:59.999Z"),
    );
    expect(endOfLocalDate("2026-03-08", "America/Los_Angeles")).toBe(
      parseInstant("2026-03-09T06:59:59.999Z"),
    );

    const sameDay = projectInventory(baseProjection({
      t0: "2026-11-01T07:00:00Z",
      horizonEnd: "2026-11-10T07:00:00Z",
      physicalQty: 0,
      receipts: [{
        id: "date-only",
        quantity: 5,
        earliestAt: null,
        latestAt: "2026-11-01",
        dateOnly: true,
        promiseState: "confirmed",
        evidenceIds: [],
      }],
      demand: [{
        id: "morning-demand",
        quantity: 5,
        requiredAt: "2026-11-01T16:00:00Z",
        certainty: "confirmed",
        includedReservedQty: 0,
      }],
    }));
    expect(sameDay.firstShortageAt).toBe("2026-11-01T16:00:00Z");
    expect(sameDay.points.at(-1)?.balance).toBe(0);

    const overdue = projectInventory(baseProjection({
      receipts: [{
        id: "late",
        quantity: 50,
        earliestAt: null,
        latestAt: "2026-10-11T15:00:00Z",
        dateOnly: false,
        promiseState: "confirmed",
        evidenceIds: [],
      }],
    }));
    expect(overdue.excludedReceipts).toContainEqual({ id: "late", reason: "overdue" });

    const exactTime = projectInventory(baseProjection({
      physicalQty: 5,
      receipts: [{
        id: "on-time",
        quantity: 5,
        earliestAt: null,
        latestAt: "2026-10-13T15:00:00Z",
        dateOnly: false,
        promiseState: "confirmed",
        evidenceIds: [],
      }],
      demand: [{
        id: "same-instant",
        quantity: 10,
        requiredAt: "2026-10-13T15:00:00Z",
        certainty: "confirmed",
        includedReservedQty: 0,
      }],
    }));
    expect(exactTime.firstShortageAt).toBeNull();
    expect(exactTime.bridgeQuantity).toBe(0);

    const pastDue = projectInventory(baseProjection({
      physicalQty: 20,
      demand: [{
        id: "past-due",
        quantity: 8,
        requiredAt: "2026-10-11T15:00:00Z",
        certainty: "confirmed",
        includedReservedQty: 0,
      }],
    }));
    expect(pastDue.pastDueDemandIds).toEqual(["past-due"]);
    expect(pastDue.points[1]).toMatchObject({ at: "2026-10-12T15:00:00Z", delta: -8 });
  });

  it("AT-08 excludes forecast demand unless requested and excludes unconfirmed or unknown receipts", () => {
    const input = baseProjection({
      physicalQty: 100,
      receipts: [
        { id: "eta-unknown", quantity: 100, earliestAt: null, latestAt: null, dateOnly: false, promiseState: "confirmed", evidenceIds: [] },
        { id: "estimated", quantity: 100, earliestAt: null, latestAt: "2026-10-13T15:00:00Z", dateOnly: false, promiseState: "estimated", evidenceIds: [] },
      ],
      demand: [{
        id: "forecast",
        quantity: 150,
        requiredAt: "2026-10-13T15:00:00Z",
        certainty: "forecast",
        includedReservedQty: 0,
      }],
    });
    const confirmed = projectInventory(input);
    const scenario = projectForecastScenario(input);
    expect(confirmed.excludedDemand).toEqual([{ id: "forecast", reason: "forecast" }]);
    expect(confirmed.excludedReceipts).toEqual([
      { id: "eta-unknown", reason: "eta_unknown" },
      { id: "estimated", reason: "not_confirmed" },
    ]);
    expect(confirmed.bridgeQuantity).toBe(0);
    expect(scenario.bridgeQuantity).toBe(50);
  });

  it("AT-09 returns no shortage for stock that covers every confirmed requirement", () => {
    const result = projectInventory(baseProjection({
      physicalQty: 1_500,
      demand: [400, 400, 400].map((quantity, index) => ({
        id: `d${index}`,
        quantity,
        requiredAt: `2026-10-${13 + index}T15:00:00Z`,
        certainty: "confirmed" as const,
        includedReservedQty: 0,
      })),
    }));
    expect(result.bridgeQuantity).toBe(0);
    expect(result.requirements).toEqual([]);
    expect(result.quality).toBe("sufficient");
  });

  it("returns insufficient results with null shortage fields for invalid or missing facts", () => {
    const invalid = projectInventory(baseProjection({ unit: " ", physicalQty: -1 }));
    expect(invalid.quality).toBe("insufficient");
    expect(invalid.points).toEqual([]);
    expect(invalid.firstShortageAt).toBeNull();
    expect(invalid.bridgeQuantity).toBeNull();
    expect(invalid.requirements).toEqual([]);
    expect(invalid.usableStart).toBeNull();
    expect(invalid.inputFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(invalid.missingFacts).toContain("missing:unit");
    expect(invalid.missingFacts).toContain("invalid_quantity:physical");
  });

  it("fingerprints are stable across equivalent ordering and change on material edits", () => {
    const first = baseProjection({
      demand: [
        { id: "b", quantity: 2, requiredAt: "2026-10-14T09:00:00-07:00", certainty: "confirmed", includedReservedQty: 0 },
        { id: "a", quantity: 1, requiredAt: "2026-10-13T16:00:00Z", certainty: "confirmed", includedReservedQty: 0 },
      ],
      pendingClaims: [{ id: "claim", quantity: 4 }],
    });
    const reordered = {
      ...first,
      demand: [...first.demand].reverse().map((item) => ({
        ...item,
        requiredAt: item.id === "b" ? "2026-10-14T16:00:00Z" : item.requiredAt,
      })),
      pendingClaims: [...first.pendingClaims].reverse(),
    };
    expect(projectInventory(first).inputFingerprint).toBe(projectInventory(reordered).inputFingerprint);
    expect(projectInventory({ ...reordered, safetyBufferQty: 1 }).inputFingerprint).not.toBe(
      projectInventory(first).inputFingerprint,
    );
  });
});
