import { projectInventory } from "./inventory";
import { parseInstant } from "./time";
import type { ProjectionDiagnostics } from "./projection-types";
import type { ProjectionInput, ProjectionResult } from "./types";

export type AssessmentContext = {
  now: string;
  mode: "replay" | "sandbox" | "live";
  freshnessThresholdMs?: number;
  itemBaseUnit: string;
  sources: { kind: "inventory" | "demand" | "commitments"; id: string; sourceAsOf: string }[];
  sourceType?: "csv" | "connector" | "fixture";
};

export type AssessmentProjection = ProjectionResult & ProjectionDiagnostics;

export function assessInventory(
  input: ProjectionInput,
  context: AssessmentContext,
): {
  projection: AssessmentProjection;
  liveCommitmentAllowed: boolean;
  missingFacts: string[];
  staleSources: string[];
} {
  const initial = projectInventory(input);
  const missingFacts = [...initial.missingFacts];
  const now = parseInstant(context.now);
  if (now === null) missingFacts.push("invalid:now");
  const threshold = context.freshnessThresholdMs ?? 15 * 60_000;
  const staleSources: string[] = [];

  if (input.unit !== context.itemBaseUnit) {
    missingFacts.push(`unit_mismatch:${input.unit}!=${context.itemBaseUnit}`);
  }
  if (!context.sources.some((source) => source.kind === "inventory")) {
    missingFacts.push("missing:inventory_snapshot");
  }
  for (const source of context.sources) {
    const sourceAsOf = parseInstant(source.sourceAsOf);
    if (sourceAsOf === null) {
      missingFacts.push(`invalid:source_as_of:${source.kind}:${source.id}`);
    } else if (now !== null && sourceAsOf > now) {
      missingFacts.push(`contradictory:source_as_of_in_future:${source.kind}:${source.id}`);
    } else if (now !== null && now - sourceAsOf > threshold) {
      staleSources.push(`stale:${source.kind}:${source.id}`);
    }
  }
  if (context.mode === "live") missingFacts.push(...staleSources);

  const uniqueMissingFacts = [...new Set(missingFacts)].sort();
  const downgraded = uniqueMissingFacts.length > 0;
  const projection: AssessmentProjection = downgraded
    ? {
        ...initial,
        quality: "insufficient",
        missingFacts: uniqueMissingFacts,
        points: [],
        firstShortageAt: null,
        bridgeQuantity: null,
        requirements: [],
        usableStart: null,
        coverageStart: null,
        finalBalance: null,
      }
    : initial;
  return {
    projection,
    missingFacts: uniqueMissingFacts,
    staleSources: [...new Set(staleSources)].sort(),
    liveCommitmentAllowed:
      projection.quality === "sufficient" &&
      context.mode === "live" &&
      staleSources.length === 0 &&
      context.sourceType !== "csv" &&
      context.sourceType !== "fixture",
  };
}
