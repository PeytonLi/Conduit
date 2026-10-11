import { describe, expect, it } from "vitest";
import { projectionEmptyMessage } from "@/lib/ui/projection-empty-message";

describe("empty stock projection message", () => {
  it("explains missing business data by name", () => {
    expect(projectionEmptyMessage({
      quality: "insufficient",
      missing_facts: ["missing:inventory_snapshot", "missing:active_dataset"],
    })).toBe(
      "Stock projection is unavailable because required data is missing: an inventory snapshot, an active business-data dataset.",
    );
  });

  it("identifies stale inputs", () => {
    expect(projectionEmptyMessage({
      quality: "insufficient",
      missing_facts: ["stale:inventory:snapshot-1"],
    })).toBe("Stock projection is unavailable because its source data is stale.");
  });

  it("explains when an assessment has no stored projection snapshot", () => {
    expect(projectionEmptyMessage({ quality: "sufficient", missing_facts: [] }))
      .toBe("No stock projection snapshot was stored for this assessment.");
  });

  it("distinguishes a case with no assessment snapshot", () => {
    expect(projectionEmptyMessage(null))
      .toBe("No assessment snapshot is stored for this case.");
  });
});
