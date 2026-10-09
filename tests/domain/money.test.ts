import { describe, expect, it } from "vitest";
import {
  currencyMinorDigits,
  formatMinor,
  MAX_MONEY_MINOR,
  mulQtyPrice,
  parseMajorDecimal,
  parseMinorUnits,
  sumMinor,
  toMinorString,
} from "@/lib/domain/money";

describe("money domain primitives", () => {
  it("AT-41 accepts exact multi-component totals near the supported maximum", () => {
    const itemTotal = mulQtyPrice(999_999_999, 1_000n);
    expect(itemTotal).toBe(999_999_999_000n);
    expect(sumMinor(itemTotal, 500n, 300n, 200n)).toBe(MAX_MONEY_MINOR);
    expect(toMinorString(MAX_MONEY_MINOR)).toBe("1000000000000");
  });

  it("AT-41 rejects values above the maximum and multiplication overflow", () => {
    expect(() => parseMinorUnits("9007199254740993")).toThrowError(
      expect.objectContaining({ code: "out_of_range" }),
    );
    expect(() => mulQtyPrice(1_000_000_000, 10_000n)).toThrowError(
      expect.objectContaining({ code: "out_of_range" }),
    );
    expect(() => mulQtyPrice(1, -1n)).toThrowError(
      expect.objectContaining({ code: "out_of_range" }),
    );
    expect(() => sumMinor(MAX_MONEY_MINOR, 1n)).toThrowError(
      expect.objectContaining({ code: "out_of_range" }),
    );
  });

  it("AT-41 rejects extra precision and allows negative amounts only when explicit", () => {
    expect(parseMajorDecimal("1", "USD")).toBe(100n);
    expect(parseMajorDecimal("0.42", "USD")).toBe(42n);
    expect(() => parseMajorDecimal("0.425", "USD")).toThrowError(
      expect.objectContaining({ code: "extra_precision" }),
    );
    expect(() => parseMinorUnits("-2100")).toThrowError(
      expect.objectContaining({ code: "not_integer" }),
    );
    expect(parseMinorUnits("-2100", { allowNegative: true })).toBe(-2100n);
    expect(() => parseMajorDecimal("-1.00", "USD")).toThrow();
    expect(parseMajorDecimal("-210.00", "USD", { allowNegative: true })).toBe(-21_000n);
  });

  it("formats currency minor units without floating point", () => {
    expect(currencyMinorDigits("USD")).toBe(2);
    expect(formatMinor(42n, "USD")).toBe("0.42");
    expect(formatMinor(-21_000n, "USD")).toBe("-210.00");
    expect(formatMinor(42n, "JPY")).toBe("42");
    expect(() => currencyMinorDigits("usd")).toThrowError(
      expect.objectContaining({ code: "invalid_currency" }),
    );
  });
});
