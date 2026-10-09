import { describe, expect, it } from "vitest";
import { formatDateTime, formatDateTimeRange, formatMoney, formatQuantity, formatQuantityChange } from "./format";

describe("F6 formatters", () => {
  it("formats the fixture deadline in the location timezone", () => {
    expect(formatDateTime("2026-10-14T16:00:00.000Z", "America/Los_Angeles"))
      .toBe("Wed, Oct 14, 9:00 AM PDT");
  });

  it("formats integer minor-unit money without floating point", () => {
    expect(formatMoney("31200", "USD")).toBe("USD 312.00");
    expect(formatMoney(7500n, "USD")).toBe("USD 75.00");
    expect(formatMoney("140000", "USD")).toBe("USD 1,400.00");
  });

  it("formats quantities with their unit", () => {
    expect(formatQuantity(600, "carton")).toBe("600 cartons");
    expect(formatQuantity(1, "carton")).toBe("1 carton");
    expect(formatQuantity(600, "cartons")).toBe("600 cartons");
    expect(formatQuantity(1, "cartons")).toBe("1 carton");
  });

  it("collapses equal range endpoints and uses a Unicode minus for negative changes", () => {
    expect(formatDateTimeRange(
      "2026-10-14T15:00:00Z",
      "2026-10-14T15:00:00+00:00",
      "America/Los_Angeles",
    )).toBe("Wed, Oct 14, 8:00 AM PDT");
    expect(formatDateTimeRange(
      "2026-10-14T15:00:00Z",
      "2026-10-16T15:00:00Z",
      "America/Los_Angeles",
    )).toBe("Wed, Oct 14, 8:00 AM PDT–Fri, Oct 16, 8:00 AM PDT");
    expect(formatQuantityChange(-400, "carton")).toBe("−400 cartons");
    expect(formatQuantityChange(600, "carton")).toBe("600 cartons");
  });
});
