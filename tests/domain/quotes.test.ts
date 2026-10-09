import { describe, expect, it } from "vitest";
import {
  evaluateQuote,
  incrementalCost,
  rankQuotes,
  type QuoteContext,
  type QuoteTerms,
} from "@/lib/domain/quotes";

const context: QuoteContext = {
  now: "2026-10-12T15:00:00Z",
  itemId: "carton",
  itemSpec: { lengthMm: 300, widthMm: 200, heightMm: 150, materialGrade: "KRAFT-SW-DEMO" },
  itemBaseUnit: "carton",
  orgCurrency: "USD",
  destinationLocationId: "main",
  requiredQty: 600,
};

function quote(overrides: Partial<QuoteTerms> = {}): QuoteTerms {
  return {
    id: "north",
    supplierId: "supplier",
    supplierPurchasingStatus: "approved",
    contactId: "contact",
    itemId: "carton",
    spec: { lengthMm: 300, widthMm: 200, heightMm: 150, materialGrade: "KRAFT-SW-DEMO" },
    unit: "carton",
    availableQty: 1_000,
    packSize: 1,
    minimumQty: 1,
    unitPriceMinor: 42n,
    currency: "USD",
    freightMinor: 6_000n,
    feesMinor: 0n,
    nonrecoverableTaxMinor: 0n,
    destinationLocationId: "main",
    arrivalStart: "2026-10-14T14:00:00Z",
    arrivalEnd: "2026-10-14T15:00:00Z",
    validUntil: "2026-10-20T15:00:00Z",
    latestOrderAt: "2026-10-13T15:00:00Z",
    arrivalGuaranteedUntilExpiry: false,
    status: "verified",
    writtenConfirmationEvidenceId: "written-1",
    verifiedAt: context.now,
    availabilityConfirmedAt: context.now,
    reservesQuantityThroughExecution: true,
    ...overrides,
  };
}

describe("quote evaluation and ranking", () => {
  it("AT-17 rejects incompatible, expired, unavailable, and incomplete offers before ranking", () => {
    const wrongSize = evaluateQuote(quote({
      id: "budget-box",
      spec: { lengthMm: 350, widthMm: 250, heightMm: 200, materialGrade: "KRAFT-STD" },
      unitPriceMinor: 1n,
    }), context);
    expect(wrongSize.outcome).toBe("rejected");
    expect(wrongSize.reasons).toContain("specification_mismatch");

    expect(evaluateQuote(quote({ id: "expired", status: "expired" }), context).outcome).toBe("rejected");
    expect(evaluateQuote(quote({ id: "unavailable", availableQty: 100 }), context).reasons).toContain("insufficient_availability");
    expect(evaluateQuote(quote({ id: "no-freight", freightMinor: null }), context).outcome).toBe("incomplete");

    const staleAvailability = evaluateQuote(quote({
      id: "stale",
      availabilityConfirmedAt: "2026-10-12T13:59:00Z",
      reservesQuantityThroughExecution: false,
    }), context);
    expect(staleAvailability.outcome).toBe("needs_revalidation");

    const provisional = evaluateQuote(quote({
      id: "provisional",
      status: "provisional",
      writtenConfirmationEvidenceId: null,
    }), context);
    expect(provisional.outcome).toBe("incomplete");
  });

  it("AT-17 rounds to pack multiples and exposes surplus without changing shortage quantity", () => {
    const evaluation = evaluateQuote(quote({ packSize: 250, unitPriceMinor: 10n, freightMinor: 0n }), context);
    expect(evaluation.orderQty).toBe(750);
    expect(evaluation.surplusQty).toBe(150);
    expect(evaluation.surplusCostMinor).toBe(1_500n);
    expect(evaluation.landedCostMinor).toBe(7_500n);
  });

  it("AT-17 ranks feasible verified terms above cheaper provisional or rejected offers", () => {
    const feasible = evaluateQuote(quote({ id: "verified" }), context);
    const provisional = evaluateQuote(quote({
      id: "verbal",
      status: "provisional",
      writtenConfirmationEvidenceId: null,
      unitPriceMinor: 1n,
    }), context);
    const wrongSize = evaluateQuote(quote({
      id: "wrong-size",
      spec: { lengthMm: 350, widthMm: 250, heightMm: 200, materialGrade: "KRAFT-STD" },
      unitPriceMinor: 1n,
    }), context);
    const ranking = rankQuotes([provisional, wrongSize, feasible]);
    expect(ranking.ranked.map((item) => item.quoteId)).toEqual(["verified", "verbal"]);
    expect(ranking.rejected.map((item) => item.quoteId)).toEqual(["wrong-size"]);
    expect(ranking.recommended?.quoteId).toBe("verified");
  });

  it("AT-18 separates landed gross commitment from confirmed-credit net incremental cost", () => {
    const evaluation = evaluateQuote(quote(), context);
    expect(evaluation.landedCostMinor).toBe(31_200n);
    expect(incrementalCost({
      newRecoveryCostMinor: evaluation.landedCostMinor!,
      originalOrderChangeFeesMinor: 0n,
      confirmedOriginalOrderCreditsMinor: 21_000n,
    })).toBe(10_200n);
  });

  it("AT-41 computes near-limit landed totals exactly and rejects overflow amounts", () => {
    const nearMaximum = evaluateQuote(quote({
      availableQty: 999_999_999,
      packSize: 1,
      minimumQty: 1,
      unitPriceMinor: 1_000n,
      freightMinor: 500n,
      feesMinor: 300n,
      nonrecoverableTaxMinor: 200n,
    }), {
      ...context,
      requiredQty: 999_999_999,
    });
    expect(nearMaximum.landedCostMinor).toBe(1_000_000_000_000n);
    expect(nearMaximum.outcome).toBe("feasible");

    const overflow = evaluateQuote(quote({
      unitPriceMinor: 10_000n,
      availableQty: 1_000_000_000,
      packSize: 1,
    }), {
      ...context,
      requiredQty: 1_000_000_000,
    });
    expect(overflow.outcome).toBe("rejected");
    expect(overflow.reasons).toContain("out_of_range");
  });
});
