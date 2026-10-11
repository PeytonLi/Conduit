import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import { isQuantity } from "./quantity";
import { compareText, endOfLocalDate, isValidTimeZone, parseInstant, toIso } from "./time";
import type { ProjectionDiagnostics } from "./projection-types";
import type { ProjectionInput, ProjectionPoint, ProjectionResult } from "./types";

type ProjectionOutput = ProjectionResult & ProjectionDiagnostics;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareText(left, right))
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
      .sort((left, right) => compareText(left.id, right.id)),
    demand: input.demand
      .map((demand) => ({ ...demand, requiredAt: canonicalTime(demand.requiredAt) }))
      .sort((left, right) => compareText(left.id, right.id)),
    pendingClaims: [...input.pendingClaims].sort((left, right) => compareText(left.id, right.id)),
  };
  return createHash("sha256").update(JSON.stringify(canonicalize(copy))).digest("hex");
}

function canonicalTime(value: string): string {
  const parsed = parseInstant(value);
  return parsed === null ? value : toIso(parsed);
}

const INPUT_KEYS = [
  "t0",
  "timezone",
  "unit",
  "horizonEnd",
  "physicalQty",
  "unusableQty",
  "outsideAllocationsQty",
  "safetyBufferQty",
  "receipts",
  "demand",
  "pendingClaims",
];
const RECEIPT_KEYS = ["id", "quantity", "earliestAt", "latestAt", "dateOnly", "promiseState", "evidenceIds"];
const DEMAND_KEYS = ["id", "quantity", "requiredAt", "certainty", "includedReservedQty"];
const CLAIM_KEYS = ["id", "quantity"];

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !isProxy(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasExactDataKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isPlainRecord(value) || Object.keys(value).length !== keys.length) return false;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return false;
  }
  return true;
}

function isDensePlainArray(value: unknown, rejectIterator = false): value is unknown[] {
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const keys = Object.keys(value);
  if (keys.length !== value.length) return false;
  if (Object.getOwnPropertyDescriptor(value, "map")) return false;
  if (rejectIterator && Object.getOwnPropertyDescriptor(value, Symbol.iterator)) return false;
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) return false;
  }
  return true;
}

function hasKnownProjectionShape(input: ProjectionInput): boolean {
  if (!hasExactDataKeys(input, INPUT_KEYS)) return false;
  if (
    typeof input.t0 !== "string" ||
    typeof input.timezone !== "string" ||
    typeof input.unit !== "string" ||
    typeof input.horizonEnd !== "string" ||
    typeof input.physicalQty !== "number" ||
    typeof input.unusableQty !== "number" ||
    typeof input.outsideAllocationsQty !== "number" ||
    typeof input.safetyBufferQty !== "number" ||
    !isDensePlainArray(input.receipts, true) ||
    !isDensePlainArray(input.demand, true) ||
    !isDensePlainArray(input.pendingClaims, true)
  ) {
    return false;
  }

  for (const receipt of input.receipts) {
    if (
      !hasExactDataKeys(receipt, RECEIPT_KEYS) ||
      typeof receipt.id !== "string" ||
      typeof receipt.quantity !== "number" ||
      (receipt.earliestAt !== null && typeof receipt.earliestAt !== "string") ||
      (receipt.latestAt !== null && typeof receipt.latestAt !== "string") ||
      typeof receipt.dateOnly !== "boolean" ||
      typeof receipt.promiseState !== "string" ||
      !isDensePlainArray(receipt.evidenceIds, true)
    ) {
      return false;
    }
    for (const evidenceId of receipt.evidenceIds) {
      if (typeof evidenceId !== "string") return false;
    }
  }

  for (const demand of input.demand) {
    if (
      !hasExactDataKeys(demand, DEMAND_KEYS) ||
      typeof demand.id !== "string" ||
      typeof demand.quantity !== "number" ||
      typeof demand.requiredAt !== "string" ||
      typeof demand.certainty !== "string" ||
      typeof demand.includedReservedQty !== "number"
    ) {
      return false;
    }
  }

  for (const claim of input.pendingClaims) {
    if (
      !hasExactDataKeys(claim, CLAIM_KEYS) ||
      typeof claim.id !== "string" ||
      typeof claim.quantity !== "number"
    ) {
      return false;
    }
  }
  return true;
}

function createTimeCache() {
  const parsed = new Map<string, number | null>();
  const formatted = new Map<number, string>();
  const localEnds = new Map<string, Map<string, number>>();

  function parse(value: string): number | null {
    if (parsed.has(value)) return parsed.get(value)!;
    const result = parseInstant(value);
    parsed.set(value, result);
    return result;
  }

  function iso(epochMs: number): string {
    const result = formatted.get(epochMs);
    if (result !== undefined) return result;
    const value = toIso(epochMs);
    formatted.set(epochMs, value);
    return value;
  }

  function localEnd(value: string, timeZone: string): number {
    let dates = localEnds.get(timeZone);
    if (!dates) {
      dates = new Map();
      localEnds.set(timeZone, dates);
    }
    if (dates.has(value)) return dates.get(value)!;
    const result = endOfLocalDate(value, timeZone);
    dates.set(value, result);
    return result;
  }

  return {
    parse,
    iso,
    localEnd,
    canonical: (value: string) => {
      const epochMs = parse(value);
      return epochMs === null ? value : iso(epochMs);
    },
  };
}

type ProjectionTimeCache = ReturnType<typeof createTimeCache>;

function sortedById<T extends { id: string }>(values: T[]): T[] {
  for (let index = 1; index < values.length; index++) {
    if (compareText(values[index - 1].id, values[index].id) > 0) {
      return [...values].sort((left, right) => compareText(left.id, right.id));
    }
  }
  return values;
}

function sortedEvidenceIds(values: string[]): string[] {
  for (let index = 1; index < values.length; index++) {
    if (compareText(values[index - 1], values[index]) > 0) return [...values].sort();
  }
  return values;
}

function fingerprintKnownInput(input: ProjectionInput, times: ProjectionTimeCache): string {
  const copy = {
    demand: sortedById(input.demand).map((demand) => ({
      certainty: demand.certainty,
      id: demand.id,
      includedReservedQty: demand.includedReservedQty,
      quantity: demand.quantity,
      requiredAt: times.canonical(demand.requiredAt),
    })),
    horizonEnd: times.canonical(input.horizonEnd),
    outsideAllocationsQty: input.outsideAllocationsQty,
    pendingClaims: sortedById(input.pendingClaims).map((claim) => ({
      id: claim.id,
      quantity: claim.quantity,
    })),
    physicalQty: input.physicalQty,
    receipts: sortedById(input.receipts).map((receipt) => ({
      dateOnly: receipt.dateOnly,
      earliestAt: receipt.earliestAt === null ? null : times.canonical(receipt.earliestAt),
      evidenceIds: sortedEvidenceIds(receipt.evidenceIds),
      id: receipt.id,
      latestAt: receipt.latestAt === null ? null : times.canonical(receipt.latestAt),
      promiseState: receipt.promiseState,
      quantity: receipt.quantity,
    })),
    safetyBufferQty: input.safetyBufferQty,
    t0: times.canonical(input.t0),
    timezone: input.timezone,
    unit: input.unit,
    unusableQty: input.unusableQty,
  };
  return createHash("sha256").update(JSON.stringify(copy)).digest("hex");
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

function validationFacts(input: ProjectionInput, times?: ProjectionTimeCache): string[] {
  const parse = times?.parse ?? parseInstant;
  const endDate = times?.localEnd ?? endOfLocalDate;
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

  const t0 = parse(input.t0);
  const horizonEnd = parse(input.horizonEnd);
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
    const earliest = receipt.earliestAt === null ? null : parse(receipt.earliestAt);
    let latest = receipt.latestAt === null ? null : parse(receipt.latestAt);
    if (receipt.dateOnly && receipt.latestAt && /^\d{4}-\d{2}-\d{2}$/.test(receipt.latestAt)) {
      try {
        latest = endDate(receipt.latestAt, input.timezone);
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
    if (parse(demand.requiredAt) === null) {
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
  const times = hasKnownProjectionShape(input) ? createTimeCache() : undefined;
  const inputFingerprint = times ? fingerprintKnownInput(input, times) : fingerprintInput(input);
  const missingFacts = validationFacts(input, times);
  if (missingFacts.length > 0) return insufficient(inputFingerprint, missingFacts);

  const parse = times?.parse ?? parseInstant;
  const format = times?.iso ?? toIso;
  const endDate = times?.localEnd ?? endOfLocalDate;
  const t0 = parse(input.t0)!;
  const horizonEnd = parse(input.horizonEnd)!;
  const usableStart =
    input.physicalQty -
    input.unusableQty -
    input.outsideAllocationsQty -
    input.pendingClaims.reduce((total, claim) => total + claim.quantity, 0);
  const coverageStart = usableStart - input.safetyBufferQty;
  const startAt = format(t0);
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
    const parsed = parse(receipt.latestAt);
    const effectiveAt = receipt.dateOnly
      ? endDate(receipt.latestAt, input.timezone)
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
    const requiredAt = parse(demand.requiredAt)!;
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
      compareText(left.sourceId, right.sourceId),
  );

  const points: ProjectionPoint[] = [
    { at: startAt, kind: "start", delta: coverageStart, balance: coverageStart, sourceId: null },
  ];
  let balance = coverageStart;
  for (const event of events) {
    balance += event.delta;
    points.push({
      at: format(event.at),
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
