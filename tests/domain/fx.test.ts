import { describe, expect, it } from "vitest";
import { convertCost, type FxRate } from "@/lib/domain/fx";
import { orderOptions } from "@/lib/db/queries/derive";

const now = new Date("2026-10-12T15:00:00Z");
const rate: FxRate = { id: "manual", from_currency: "EUR", to_currency: "USD",
  numerator: "11", denominator: "10", source: "Owner: bank statement", as_of: now.toISOString() };
const context = { home_currency: "USD", fx_rate: rate, fx_max_age_seconds: 3600 };

describe("explicit FX costs", () => {
  it("preserves originals and never supplies an unknown or mismatched rate", () => {
    expect(convertCost(100n, "EUR", { home_currency: "USD" }, now)).toMatchObject({
      original_minor: "100", original_currency: "EUR", converted_minor: null, reason: "fx_rate_missing",
    });
    expect(convertCost(100n, "GBP", context, now).reason).toBe("fx_rate_missing");
    expect(convertCost(100n, "USD", context, now).converted_minor).toBe("100");
  });
  it("expires at the policy boundary and rejects future and invalid evidence", () => {
    expect(convertCost(100n, "EUR", context, new Date(now.getTime() + 3600000)).reason).toBe("fx_rate_stale");
    expect(convertCost(100n, "EUR", context, new Date(now.getTime() - 1)).reason).toBe("fx_rate_invalid");
    expect(convertCost(100n, "EUR", { ...context, fx_rate: { ...rate, denominator: "0" } }, now).reason).toBe("fx_rate_invalid");
  });
  it("rounds halves away from zero, supports different minor-unit scales, and rejects overflow", () => {
    expect(convertCost(5n, "EUR", context, now).converted_minor).toBe("6");
    expect(convertCost(-5n, "EUR", context, now).converted_minor).toBe("-6");
    expect(convertCost(1000000000000n, "EUR", context, now).reason).toBe("fx_amount_out_of_range");
    expect(convertCost(150n, "JPY", { ...context, fx_rate: { ...rate, from_currency: "JPY", numerator: "2", denominator: "3" } }, now).converted_minor).toBe("100");
  });
  it("compares plans by home currency, including a cheaper raw quote that converts higher", () => {
    const option = (id: string, cost: string | null) => ({ id, specification_status: "match" as const,
      quote_status: "verified", written_confirmation: true, quantity: 1,
      schedule: [{ quantity: 1, arrival_start: now.toISOString() }],
      costs: { net_incremental_minor: cost }, missing_fields: [], reasons: [] });
    const eur = convertCost(950n, "EUR", context, now);
    expect(eur).toMatchObject({ converted_minor: "1045", rate });
    expect(orderOptions([option("eur", eur.converted_minor), option("usd", "1000"), option("unknown", null)])
      .map((row) => row.id)).toEqual(["usd", "eur", "unknown"]);
  });
});
