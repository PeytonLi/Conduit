import { describe, expect, it } from "vitest";
import { scanForShortages, type ShortageScanDeps } from "@/lib/workflows/shortage-scan";
import type { ProjectionFactsResult } from "@/lib/agent/store";
import { baseProjection } from "./domain-test-helpers";

const t0 = "2026-10-12T15:00:00Z";
const demand = (quantity: number) => [{
  id: `d-${quantity}`,
  quantity,
  requiredAt: "2026-10-20T16:00:00Z",
  certainty: "confirmed" as const,
  includedReservedQty: 0,
}];

function built(quantity: number | null): ProjectionFactsResult {
  return {
    input: quantity === null ? null : baseProjection({ t0, physicalQty: 600, demand: demand(quantity) }),
    context: { itemBaseUnit: "carton", sources: [{ kind: "inventory", id: "s", sourceAsOf: t0 }], sourceType: "connector" },
    lines: {},
    missingFacts: quantity === null ? ["missing:inventory_snapshot"] : [],
  } as unknown as ProjectionFactsResult;
}

function deps(mode: "replay" | "sandbox" | "live", byItem: Record<string, number | null>) {
  const opened: string[] = [];
  const d: ShortageScanDeps = {
    listPairs: async () => Object.keys(byItem).map((item_id) => ({ item_id, location_id: "loc" })),
    loadInput: async (_org, pair) => built(byItem[pair.item_id]),
    getMode: async () => mode,
    openCase: async (_org, pair) => {
      opened.push(pair.item_id);
      return { status: "opened", case_id: `case-${pair.item_id}` };
    },
    now: () => new Date("2026-10-12T15:05:00Z"),
  };
  return { d, opened };
}

describe("business shortage scan", () => {
  it("opens a case only where open demand exceeds stock and receipts", async () => {
    const { d, opened } = deps("live", { short: 900, covered: 100, unknown: null });
    const report = await scanForShortages(d, { orgId: "org", datasetId: "ds" });
    expect(opened).toEqual(["short"]);
    expect(report).toEqual({ scanned: 3, opened: ["case-short"] });
  });

  it("never opens cases in replay", async () => {
    const { d, opened } = deps("replay", { short: 900 });
    expect(await scanForShortages(d, { orgId: "org", datasetId: "ds" })).toEqual({ scanned: 0, opened: [] });
    expect(opened).toEqual([]);
  });
});
