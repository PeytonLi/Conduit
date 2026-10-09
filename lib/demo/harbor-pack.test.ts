import { describe, expect, it } from "vitest";
import expected from "../../tests/fixtures/harbor-pack/expected.json";
import {
  HARBOR_PACK_EXPECTED,
  HARBOR_PACK_FIXTURE_CLOCK,
} from "./fixtures";

describe("Harbor Pack fixture constants", () => {
  it("match the committed arithmetic ground truth", () => {
    expect(new Date(HARBOR_PACK_FIXTURE_CLOCK).toISOString())
      .toBe(new Date(expected.fixture_clock).toISOString());
    expect(HARBOR_PACK_EXPECTED.firstShortageAt).toBe(expected.first_shortage_at);
    expect(HARBOR_PACK_EXPECTED.bridgeQuantity).toBe(expected.bridge_quantity);
    expect(HARBOR_PACK_EXPECTED.requirements).toEqual(expected.requirements);
    expect(HARBOR_PACK_EXPECTED.splitIncrementalCost).toBe(expected.split_incremental_cost);
    expect(HARBOR_PACK_EXPECTED.alternativeGross).toBe(expected.alternative_gross);
  });
});
