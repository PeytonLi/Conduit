import { describe, expect, it } from "vitest";
import { assertQuantity, isQuantity, MAX_QUANTITY, parseQuantity } from "@/lib/domain/quantity";
import { DomainValidationError } from "@/lib/domain/errors";

describe("quantity domain primitives", () => {
  it("accepts only safe whole quantities in the supported range", () => {
    expect(isQuantity(0)).toBe(true);
    expect(isQuantity(MAX_QUANTITY)).toBe(true);
    expect(isQuantity(-1)).toBe(false);
    expect(isQuantity(1.5)).toBe(false);
    expect(isQuantity(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    expect(isQuantity(MAX_QUANTITY + 1)).toBe(false);
    expect(() => assertQuantity(-1, "ordered_qty")).toThrow(DomainValidationError);
    expect(() => assertQuantity(-1, "ordered_qty")).toThrow(/ordered_qty/);
  });

  it("parses digit strings without coercing signs, fractions, exponents, or whitespace", () => {
    expect(parseQuantity("0007")).toEqual({ ok: true, value: 7 });
    expect(parseQuantity("")).toEqual({ ok: false, code: "empty" });
    expect(parseQuantity("-1")).toEqual({ ok: false, code: "not_integer" });
    expect(parseQuantity("1.5")).toEqual({ ok: false, code: "not_integer" });
    expect(parseQuantity("1e2")).toEqual({ ok: false, code: "not_integer" });
    expect(parseQuantity(" 1")).toEqual({ ok: false, code: "not_integer" });
    expect(parseQuantity("1000000001")).toEqual({ ok: false, code: "out_of_range" });
  });
});
