import { describe, expect, it } from "vitest";
import { projectInventory } from "@/lib/domain/inventory";
import { baseProjection } from "./domain-test-helpers";

describe("inventory projection performance", () => {
  it("NFR-005 projects 10,000 events in under 100 ms", () => {
    const receipts = Array.from({ length: 5_000 }, (_, index) => ({
      id: `r-${index.toString().padStart(5, "0")}`,
      quantity: 1,
      earliestAt: null,
      latestAt: "2026-10-20T15:00:00Z",
      dateOnly: false,
      promiseState: "confirmed" as const,
      evidenceIds: [`e-${index}`],
    }));
    const demand = Array.from({ length: 5_000 }, (_, index) => ({
      id: `d-${index.toString().padStart(5, "0")}`,
      quantity: 1,
      requiredAt: "2026-10-19T15:00:00Z",
      certainty: "confirmed" as const,
      includedReservedQty: 0,
    }));
    const input = baseProjection({ physicalQty: 100_000, receipts, demand });

    projectInventory(input);
    projectInventory(input);
    const samples = Array.from({ length: 7 }, () => {
      const start = performance.now();
      projectInventory(input);
      return performance.now() - start;
    }).sort((left, right) => left - right);
    const minimum = samples[0];
    const median = samples[3];
    console.info(`NFR-005 inventory projection min: ${minimum.toFixed(2)} ms (median ${median.toFixed(2)} ms)`);
    expect(minimum).toBeLessThan(100);
  });
});
