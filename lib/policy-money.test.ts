import { describe, expect, it } from "vitest";
import { parsePolicyMoneyMinor } from "./policy-money";

describe("parsePolicyMoneyMinor", () => {
  it("parses decimal strings exactly into minor units", () => {
    expect(parsePolicyMoneyMinor("12.34")).toBe("1234");
    expect(parsePolicyMoneyMinor("12.3")).toBe("1230");
    expect(parsePolicyMoneyMinor("0.01")).toBe("1");
  });

  it("maps blank values to null and rejects invalid precision", () => {
    expect(parsePolicyMoneyMinor(" ")).toBeNull();
    expect(() => parsePolicyMoneyMinor("1.234")).toThrow();
    expect(() => parsePolicyMoneyMinor("1e2")).toThrow();
  });
});
