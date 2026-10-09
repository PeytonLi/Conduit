import { describe, expect, it } from "vitest";
import expected from "../../tests/fixtures/harbor-pack/expected.json";
import { projectInventory } from "@/lib/domain/inventory";
import { importedHarborProjection } from "../../tests/domain/domain-test-helpers";
import {
  buildHarborPackAssessmentProjection,
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

  it("keeps the canonical loader projection aligned with the domain projection engine", () => {
    const fixtureProjection = buildHarborPackAssessmentProjection("harbor-pack-canonical", 600);
    const engineProjection = projectInventory(importedHarborProjection());
    const normalizePoints = (points: typeof engineProjection.points) => points.map(({ at, kind, delta, balance }) => ({
      at: new Date(at).toISOString(),
      kind,
      delta,
      balance,
    }));
    const comparablePoints = fixtureProjection.points.map(({ at, kind, delta, balance }) => ({
      at: new Date(at).toISOString(),
      kind,
      delta,
      balance,
    }));

    expect(comparablePoints).toEqual(normalizePoints(engineProjection.points));
    expect(new Date(fixtureProjection.firstShortageAt!).toISOString())
      .toBe(new Date(engineProjection.firstShortageAt!).toISOString());
    expect(fixtureProjection.bridgeQuantity).toBe(engineProjection.bridgeQuantity);
    expect(fixtureProjection.datedRequirements.map((requirement) => ({
      by: new Date(requirement.by).toISOString(),
      cumulative_quantity: requirement.cumulative_quantity,
    }))).toEqual(engineProjection.requirements.map((requirement) => ({
      by: new Date(requirement.by).toISOString(),
      cumulative_quantity: requirement.cumulativeQuantity,
    })));
  });
});
