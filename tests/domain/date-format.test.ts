import { describe, expect, it } from "vitest";
import { formatDateTime, formatDateTimeRange } from "@/lib/db/queries/format";

describe("formatDateTimeRange", () => {
  const timeZone = "America/Los_Angeles";
  const start = "2026-10-14T09:00:00-07:00";
  const end = "2026-10-14T23:59:59-07:00";

  it("returns a present end when the range has no start", () => {
    expect(formatDateTimeRange(null, end, timeZone)).toBe(formatDateTime(end, timeZone));
  });

  it("returns the start when the end is absent and null when both are absent", () => {
    expect(formatDateTimeRange(start, null, timeZone)).toBe(formatDateTime(start, timeZone));
    expect(formatDateTimeRange(null, null, timeZone)).toBeNull();
  });
});
