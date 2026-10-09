import { describe, expect, it } from "vitest";
import { formatDateTime, formatMoney, formatQuantity } from "./format";

describe("F6 formatters", () => {
  it("formats the fixture deadline in the location timezone", () => {
    expect(formatDateTime("2026-10-14T16:00:00.000Z", "America/Los_Angeles"))
      .toBe("Wed, Oct 14, 9:00 AM PDT");
  });

  it("formats integer minor-unit money without floating point", () => {
    expect(formatMoney("31200", "USD")).toBe("USD 312.00");
    expect(formatMoney(7500n, "USD")).toBe("USD 75.00");
  });

  it("formats quantities with their unit", () => {
    expect(formatQuantity(600, "cartons")).toBe("600 cartons");
    expect(formatQuantity(1, "cartons")).toBe("1 carton");
  });
});
