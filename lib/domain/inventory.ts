import { createHash } from "node:crypto";
import { isQuantity } from "./quantity";
import { endOfLocalDate, isValidTimeZone, parseInstant, toIso } from "./time";
import type { ProjectionDiagnostics } from "./projection-types";
import type { ProjectionInput, ProjectionPoint, ProjectionResult } from "./types";

type ProjectionOutput = ProjectionResult & ProjectionDiagnostics;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function fingerprintInput(input: ProjectionInput): string {
  const copy = {
    ...input,
    t0: canonicalTime(input.t0),
    horizonEnd: canonicalTime(input.horizonEnd),
    receipts: input.receipts
      .map((receipt) => ({
        ...receipt,
        earliestAt: receipt.earliestAt === null ? null : canonicalTime(receipt.earliestAt),
        latestAt: receipt.latestAt === null ? null : canonicalTime(receipt.latestAt),
        evidenceIds: [...receipt.evidenceIds].sort(),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    demand: input.demand
      .map((demand) => ({ ...demand, requiredAt: canonicalTime(demand.requiredAt) }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    pendingClaims: [...input.pendingClaims].sort((left, right) => left.id.localeCompare(right.id)),
  };
  return createHash("sha256").update(JSON.stringify(canonicalize(copy))).digest("hex");
}

function canonicalTime(value: string): string {
  const parsed = parseInstant(value);
  return parsed === null ? value : toIso(parsed);
}

function insufficient(
  fingerprint: string,
  missingFacts: string[],
): ProjectionOutput {
  return {
    quality: "insufficient",
    missingFacts: [...new Set(missingFacts)].sort(),
    points: [],
    firstShortageAt: null,
    bridgeQuantity: null,
    requirements: [],
    inputFingerprint: fingerprint,
    usableStart: null,
    coverageStart: null,
    finalBalance: null,
    excludedReceipts: [],
    excludedDemand: [],
    pastDueDemandIds: [],
  };
}

function validationFacts(input: ProjectionInput): string[] {
  const missingFacts: string[] = [];
  for (const [name, quantity] of [
    ["physical", input.physicalQty],
    ["unusable", input.unusableQty],
    ["outside_allocations", input.outsideAllocationsQty],
    ["safety_buffer", input.safetyBufferQty],
  ] as const) {
    if (!isQuantity(quantity)) missingFacts.push(`invalid_quantity:${name}`);
  }
  if (
    isQuantity(input.physicalQty) &&
    isQuantity(input.unusableQty) &&
    isQuantity(input.outsideAllocationsQty) &&
    input.unusableQty + input.outsideAllocationsQty > input.physicalQty
  ) {
    missingFacts.push("contradictory:unusable_plus_outside_exceeds_physical");
  }
  if (!input.unit.trim()) missingFacts.push("missing:unit");
  if (!isValidTimeZone(input.timezone)) missingFacts.push("invalid_timezone");

  const t0 = parseInstant(input.t0);
  const horizonEnd = parseInstant(input.horizonEnd);
  if (t0 === null || horizonEnd === null || horizonEnd <= t0) {
    missingFacts.push("invalid_horizon");
  } else if (horizonEnd > t0 + 30 * 24 * 60 * 60 * 1000) {
    missingFacts.push("horizon_exceeds_30_days");
  }

  const seenReceipts = new Set<string>();
  for (const receipt of input.receipts) {
    if (seenReceipts.has(receipt.id)) missingFacts.push(`duplicate_id:receipt:${receipt.id}`);
    seenReceipts.add(receipt.id);
    if (!isQuantity(receipt.quantity)) missingFacts.push(`invalid_quantity:receipt:${receipt.id}`);
    const earliest = receipt.earliestAt === null ? null : parseInstant(receipt.earliestAt);
    let latest = receipt.latestAt === null ? null : parseInstant(receipt.latestAt);
    if (receipt.dateOnly && receipt.latestAt && /^\d{4}-\d{2}-\d{2}$/.test(receipt.latestAt)) {
      try {
        latest = endOfLocalDate(receipt.latestAt, input.timezone);
      } catch {
        latest = null;
      }
    }
    if (receipt.earliestAt !== null && earliest === null) {
      missingFacts.push(`invalid_time:receipt:${receipt.id}:earliestAt`);
    }
    if (receipt.latestAt !== null && latest === null) {
      missingFacts.push(`invalid_time:receipt:${receipt.id}:latestAt`);
    }
    if (earliest !== null && latest !== null && earliest > latest) {
      missingFacts.push(`contradictory:receipt_window_inverted:${receipt.id}`);
    }
  }

  const seenDemand = new Set<string>();
  for (const demand of input.demand) {
    if (seenDemand.has(demand.id)) missingFacts.push(`duplicate_id:demand:${demand.id}`);
    seenDemand.add(demand.id);
    if (!isQuantity(demand.quantity)) missingFacts.push(`invalid_quantity:demand:${demand.id}`);
    if (!isQuantity(demand.includedReservedQty)) {
      missingFacts.push(`invalid_quantity:included_reserved:${demand.id}`);
    }
    if (demand.includedReservedQty > demand.quantity) {
      missingFacts.push(`contradictory:included_reserved_exceeds_demand:${demand.id}`);
    }
    if (parseInstant(demand.requiredAt) === null) {
      missingFacts.push(`invalid_time:demand:${demand.id}:requiredAt`);
    }
  }

  const seenClaims = new Set<string>();
  for (const claim of input.pendingClaims) {
    if (seenClaims.has(claim.id)) missingFacts.push(`duplicate_id:claim:${claim.id}`);
    seenClaims.add(claim.id);
    if (!isQuantity(claim.quantity)) missingFacts.push(`invalid_quantity:claim:${claim.id}`);
  }
  return missingFacts;
}

function project(input: ProjectionInput, includeForecast: boolean): ProjectionOutput {
  const inputFingerprint = fingerprintInput(input);
  const missingFacts = validationFacts(input);
  if (missingFacts.length > 0) return insufficient(inputFingerprint, missingFacts);

  const t0 = parseInstant(input.t0)!;
  const horizonEnd = parseInstant(input.horizonEnd)!;
  const usableStart =
    input.physicalQty -
    input.unusableQty -
    input.outsideAllocationsQty -
    input.pendingClaims.reduce((total, claim) => total + claim.quantity, 0);
  const coverageStart = usableStart - input.safetyBufferQty;
  const startAt = toIso(t0);
  const events: { at: number; kind: "receipt" | "demand"; delta: number; sourceId: string }[] = [];
  const excludedReceipts: ProjectionDiagnostics["excludedReceipts"] = [];
  const excludedDemand: ProjectionDiagnostics["excludedDemand"] = [];
  const pastDueDemandIds: string[] = [];

  for (const receipt of input.receipts) {
    if (receipt.latestAt === null) {
      excludedReceipts.push({ id: receipt.id, reason: "eta_unknown" });
      continue;
    }
    if (receipt.promiseState !== "confirmed") {
      excludedReceipts.push({ id: receipt.id, reason: "not_confirmed" });
      continue;
    }
    const parsed = parseInstant(receipt.latestAt);
    const effectiveAt = receipt.dateOnly
      ? endOfLocalDate(receipt.latestAt, input.timezone)
      : parsed!;
    if (effectiveAt < t0) {
      excludedReceipts.push({ id: receipt.id, reason: "overdue" });
    } else if (effectiveAt > horizonEnd) {
      excludedReceipts.push({ id: receipt.id, reason: "beyond_horizon" });
    } else {
      events.push({ at: effectiveAt, kind: "receipt", delta: receipt.quantity, sourceId: receipt.id });
    }
  }

  for (const demand of input.demand) {
    if (demand.certainty === "forecast" && !includeForecast) {
      excludedDemand.push({ id: demand.id, reason: "forecast" });
      continue;
    }
    const requiredAt = parseInstant(demand.requiredAt)!;
    if (requiredAt > horizonEnd) {
      excludedDemand.push({ id: demand.id, reason: "beyond_horizon" });
      continue;
    }
    const effectiveAt = requiredAt < t0 ? t0 : requiredAt;
    if (requiredAt < t0) pastDueDemandIds.push(demand.id);
    events.push({ at: effectiveAt, kind: "demand", delta: -demand.quantity, sourceId: demand.id });
  }

  events.sort(
    (left, right) =>
      left.at - right.at ||
      (left.kind === right.kind ? 0 : left.kind === "receipt" ? -1 : 1) ||
      left.sourceId.localeCompare(right.sourceId),
  );

  const points: ProjectionPoint[] = [
    { at: startAt, kind: "start", delta: coverageStart, balance: coverageStart, sourceId: null },
  ];
  let balance = coverageStart;
  for (const event of events) {
    balance += event.delta;
    points.push({
      at: toIso(event.at),
      kind: event.kind,
      delta: event.delta,
      balance,
      sourceId: event.sourceId,
    });
  }

  let firstShortageAt: string | null = null;
  let minimumBalance = coverageStart;
  let runningMaxDeficit = 0;
  const requirements: ProjectionResult["requirements"] = [];
  for (const point of points) {
    minimumBalance = Math.min(minimumBalance, point.balance);
    if (firstShortageAt === null && point.balance < 0) firstShortageAt = point.at;
    const deficit = Math.max(0, -point.balance);
    if (deficit > runningMaxDeficit) {
      runningMaxDeficit = deficit;
      requirements.push({ by: point.at, cumulativeQuantity: deficit });
    }
  }

  return {
    quality: "sufficient",
    missingFacts: [],
    points,
    firstShortageAt,
    bridgeQuantity: Math.max(0, -minimumBalance),
    requirements,
    inputFingerprint,
    usableStart,
    coverageStart,
    finalBalance: balance,
    excludedReceipts,
    excludedDemand,
    pastDueDemandIds: pastDueDemandIds.sort(),
  };
}

/**
 * Claims represent active or uncertain stock reservations for this pool whose demand is not
 * in input.demand; subtracting them here ensures each stock claim is accounted for once.
 */
export function projectInventory(input: ProjectionInput): ProjectionOutput {
  return project(input, false);
}

export function projectForecastScenario(input: ProjectionInput): ProjectionOutput {
  return project(input, true);
}
