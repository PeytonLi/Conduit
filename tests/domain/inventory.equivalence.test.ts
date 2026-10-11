import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DomainValidationError } from "@/lib/domain/errors";
import { isQuantity } from "@/lib/domain/quantity";
import { compareText, endOfLocalDate, isValidTimeZone, parseInstant, toIso } from "@/lib/domain/time";
import type { ProjectionDiagnostics } from "@/lib/domain/projection-types";
import { projectForecastScenario, projectInventory } from "@/lib/domain/inventory";
import type { ProjectionInput, ProjectionPoint, ProjectionResult } from "@/lib/domain/types";
import { baseProjection, importedHarborProjection } from "./domain-test-helpers";

type ReferenceOutput = ProjectionResult & ProjectionDiagnostics;

function referenceCanonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(referenceCanonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, entry]) => [key, referenceCanonicalize(entry)]),
    );
  }
  return value;
}

function referenceCanonicalTime(value: string): string {
  const parsed = parseInstant(value);
  return parsed === null ? value : toIso(parsed);
}

function referenceFingerprintInput(input: ProjectionInput): string {
  const copy = {
    ...input,
    t0: referenceCanonicalTime(input.t0),
    horizonEnd: referenceCanonicalTime(input.horizonEnd),
    receipts: input.receipts
      .map((receipt) => ({
        ...receipt,
        earliestAt: receipt.earliestAt === null ? null : referenceCanonicalTime(receipt.earliestAt),
        latestAt: receipt.latestAt === null ? null : referenceCanonicalTime(receipt.latestAt),
        evidenceIds: [...receipt.evidenceIds].sort(),
      }))
      .sort((left, right) => compareText(left.id, right.id)),
    demand: input.demand
      .map((demand) => ({ ...demand, requiredAt: referenceCanonicalTime(demand.requiredAt) }))
      .sort((left, right) => compareText(left.id, right.id)),
    pendingClaims: [...input.pendingClaims].sort((left, right) => compareText(left.id, right.id)),
  };
  return createHash("sha256").update(JSON.stringify(referenceCanonicalize(copy))).digest("hex");
}

function referenceInsufficient(fingerprint: string, missingFacts: string[]): ReferenceOutput {
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

function referenceValidationFacts(input: ProjectionInput): string[] {
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

function referenceProject(input: ProjectionInput, includeForecast: boolean): ReferenceOutput {
  const inputFingerprint = referenceFingerprintInput(input);
  const missingFacts = referenceValidationFacts(input);
  if (missingFacts.length > 0) return referenceInsufficient(inputFingerprint, missingFacts);

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
      compareText(left.sourceId, right.sourceId),
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

type Outcome = { result: ReferenceOutput | ReturnType<typeof projectInventory> } | {
  thrown: { name: string; message: string; code?: string; field?: string };
};

function capture(operation: () => ReferenceOutput | ReturnType<typeof projectInventory>): Outcome {
  try {
    return { result: operation() };
  } catch (error) {
    if (error instanceof DomainValidationError) {
      return {
        thrown: {
          name: error.name,
          message: error.message,
          code: error.code,
          field: error.field,
        },
      };
    }
    if (error instanceof Error) return { thrown: { name: error.name, message: error.message } };
    return { thrown: { name: typeof error, message: String(error) } };
  }
}

function expectEquivalent(input: ProjectionInput): void {
  for (const includeForecast of [false, true]) {
    const expected = capture(() => referenceProject(input, includeForecast));
    const actual = capture(() =>
      includeForecast ? projectForecastScenario(input) : projectInventory(input),
    );
    expect(actual).toStrictEqual(expected);
  }
}

function expectEquivalentFromFactory(makeInput: () => ProjectionInput): void {
  for (const includeForecast of [false, true]) {
    const expected = capture(() => referenceProject(makeInput(), includeForecast));
    const actual = capture(() =>
      includeForecast ? projectForecastScenario(makeInput()) : projectInventory(makeInput()),
    );
    expect(actual).toStrictEqual(expected);
  }
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function randomItem<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length)];
}

function randomProjectionInputs(): ProjectionInput[] {
  const random = seededRandom(0x51a7e);
  const timeZones = ["America/Los_Angeles", "America/New_York", "UTC", "Pacific/Apia"];
  const instants = [
    "2026-10-11T15:00:00Z",
    "2026-10-12T15:00:00Z",
    "2026-10-12T16:00:00Z",
    "2026-10-19T15:00:00Z",
    "2026-10-20T15:00:00Z",
    "2026-11-11T15:00:00Z",
    "2026-11-13T15:00:00Z",
    "2026-03-08T09:00:00Z",
    "not-an-instant",
  ];
  const dates = ["2026-11-01", "2026-03-08", "2026-03-09", "2011-12-30", "2026-10-20"];
  const quantities = [0, 1, 5, 100, -1, Number.NaN, Number.POSITIVE_INFINITY];
  const states = ["confirmed", "estimated", "unknown"];
  const certainty = ["confirmed", "forecast", "uncertain"];
  const inputs: ProjectionInput[] = [];

  for (let index = 0; index < 300; index++) {
    const receipts = Array.from({ length: Math.floor(random() * 9) }, () => {
      const dateOnly = random() < 0.35;
      const latestAt = random() < 0.12
        ? null
        : dateOnly
          ? randomItem(dates, random)
          : randomItem(instants, random);
      return {
        id: `receipt-${Math.floor(random() * 7)}`,
        quantity: randomItem(quantities, random),
        earliestAt: random() < 0.7 ? null : randomItem(instants, random),
        latestAt,
        dateOnly,
        promiseState: randomItem(states, random) as "confirmed" | "estimated" | "unknown",
        evidenceIds: Array.from({ length: Math.floor(random() * 4) }, () => `evidence-${Math.floor(random() * 5)}`),
      };
    });
    const demand = Array.from({ length: Math.floor(random() * 9) }, () => ({
      id: `demand-${Math.floor(random() * 7)}`,
      quantity: randomItem(quantities, random),
      requiredAt: randomItem(instants, random),
      certainty: randomItem(certainty, random) as "confirmed" | "forecast",
      includedReservedQty: randomItem(quantities, random),
    }));
    const pendingClaims = Array.from({ length: Math.floor(random() * 5) }, () => ({
      id: `claim-${Math.floor(random() * 4)}`,
      quantity: randomItem(quantities, random),
    }));
    const input = baseProjection({
      t0: index % 17 === 0 ? "2026-03-08T08:00:00Z" : "2026-10-12T15:00:00Z",
      timezone: randomItem(timeZones, random),
      horizonEnd: index % 19 === 0
        ? "2026-11-20T15:00:00Z"
        : "2026-11-11T15:00:00Z",
      physicalQty: randomItem(quantities, random),
      receipts,
      demand,
      pendingClaims,
    });
    const withUnknowns = input as ProjectionInput & Record<string, unknown>;
    if (index % 11 === 0) withUnknowns.unmodeledFact = { z: index, a: "preserved in fingerprint" };
    if (index % 13 === 0 && receipts.length > 0) {
      const withExtraReceipt = { ...receipts[0], futureField: { value: index } };
      input.receipts = [withExtraReceipt as (typeof input.receipts)[number], ...receipts.slice(1)];
    }
    if (index % 17 === 0 && demand.length > 0) {
      const withExtraDemand = { ...demand[0], sourceHint: "future" };
      input.demand = [withExtraDemand as (typeof input.demand)[number], ...demand.slice(1)];
    }
    if (index % 23 === 0 && pendingClaims.length > 0) {
      const withExtraClaim = { ...pendingClaims[0], confidence: 0.5 };
      input.pendingClaims = [withExtraClaim as (typeof input.pendingClaims)[number], ...pendingClaims.slice(1)];
    }
    inputs.push(input);
  }
  return inputs;
}

function inputWithPhysicalQuantityGetter(): ProjectionInput {
  const input = baseProjection();
  let reads = 0;
  Object.defineProperty(input, "physicalQty", {
    enumerable: true,
    configurable: true,
    get() {
      if (++reads === 3) throw new DomainValidationError("invalid_quantity", "physical");
      return 600;
    },
  });
  return input;
}

describe("inventory projection equivalence", () => {
  it("matches the frozen implementation for existing helper and fixture inputs", () => {
    const inputs = [
      baseProjection(),
      importedHarborProjection(),
      baseProjection({
        physicalQty: 100_000,
        receipts: Array.from({ length: 5_000 }, (_, index) => ({
          id: `r-${index.toString().padStart(5, "0")}`,
          quantity: 1,
          earliestAt: null,
          latestAt: "2026-10-20T15:00:00Z",
          dateOnly: false,
          promiseState: "confirmed" as const,
          evidenceIds: [`e-${index}`],
        })),
        demand: Array.from({ length: 5_000 }, (_, index) => ({
          id: `d-${index.toString().padStart(5, "0")}`,
          quantity: 1,
          requiredAt: "2026-10-19T15:00:00Z",
          certainty: "confirmed" as const,
          includedReservedQty: 0,
        })),
      }),
      baseProjection({
        receipts: [{
          id: "date-only-fall-back",
          quantity: 20,
          earliestAt: null,
          latestAt: "2026-11-01",
          dateOnly: true,
          promiseState: "confirmed",
          evidenceIds: [],
        }],
      }),
      baseProjection({
        t0: "2026-03-08T08:00:00Z",
        horizonEnd: "2026-03-18T08:00:00Z",
        timezone: "America/New_York",
        receipts: [{
          id: "date-only-spring-forward",
          quantity: 20,
          earliestAt: null,
          latestAt: "2026-03-08",
          dateOnly: true,
          promiseState: "confirmed",
          evidenceIds: [],
        }],
      }),
      baseProjection({
        t0: "2011-12-29T10:00:00Z",
        horizonEnd: "2011-12-31T10:00:00Z",
        timezone: "Pacific/Apia",
        receipts: [{
          id: "skipped-local-date",
          quantity: 20,
          earliestAt: null,
          latestAt: "2011-12-30",
          dateOnly: true,
          promiseState: "confirmed",
          evidenceIds: [],
        }],
      }),
      baseProjection({
        physicalQty: 200,
        receipts: [
          { id: "z-receipt", quantity: 100, earliestAt: null, latestAt: "2026-10-20T15:00:00Z", dateOnly: false, promiseState: "confirmed", evidenceIds: ["z", "a"] },
          { id: "a-receipt", quantity: 50, earliestAt: null, latestAt: "2026-10-20T15:00:00Z", dateOnly: false, promiseState: "confirmed", evidenceIds: ["b", "a"] },
        ],
        demand: [
          { id: "z-demand", quantity: 10, requiredAt: "2026-10-20T15:00:00Z", certainty: "confirmed", includedReservedQty: 0 },
          { id: "a-demand", quantity: 20, requiredAt: "2026-10-20T15:00:00Z", certainty: "forecast", includedReservedQty: 0 },
        ],
        pendingClaims: [{ id: "claim-b", quantity: 4 }, { id: "claim-a", quantity: 5 }],
      }),
      baseProjection({
        physicalQty: -1,
        unit: " ",
        timezone: "Invalid/Zone",
        horizonEnd: "not-an-instant",
        receipts: [{
          id: "bad-window",
          quantity: -3,
          earliestAt: "not-an-instant",
          latestAt: "2026-10-10T15:00:00Z",
          dateOnly: false,
          promiseState: "confirmed",
          evidenceIds: [],
        }],
        demand: [{
          id: "bad-demand",
          quantity: -1,
          requiredAt: "not-an-instant",
          certainty: "confirmed",
          includedReservedQty: 4,
        }],
        pendingClaims: [{ id: "bad-claim", quantity: -1 }],
      }),
    ];

    for (const input of inputs) expectEquivalent(input);
  });

  it("matches fallback behavior for extra keys and thrown errors", () => {
    const inputWithUnknownKey = {
      ...baseProjection({
        receipts: [{
          id: "receipt",
          quantity: 5,
          earliestAt: null,
          latestAt: "2026-10-20T15:00:00Z",
          dateOnly: false,
          promiseState: "confirmed",
          evidenceIds: [],
          metadata: { z: 2, a: 1 },
        } as ProjectionInput["receipts"][number]],
      }),
      unrecognized: { z: "z", a: "a" },
    } as ProjectionInput;
    expectEquivalent(inputWithUnknownKey);
    expectEquivalentFromFactory(inputWithPhysicalQuantityGetter);

    const inputWithBigInt = {
      ...baseProjection(),
      futureQuantity: 1n,
    } as ProjectionInput;
    expectEquivalent(inputWithBigInt);
  });

  it("matches the frozen implementation for 300 seeded edge-case inputs", () => {
    for (const input of randomProjectionInputs()) expectEquivalent(input);
  });
});
