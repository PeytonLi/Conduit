export type HarborPackFixtureId = "harbor-pack-canonical" | "harbor-pack-harmless";

export const HARBOR_PACK_ORG_ID = "00000000-0000-4000-8000-000000000001";
export const HARBOR_PACK_FIXTURE_CLOCK = "2026-10-12T15:00:00.000Z";

export const HARBOR_PACK_EXPECTED = {
  firstShortageAt: "2026-10-14T16:00:00Z",
  bridgeQuantity: 600,
  requirements: [
    { by: "2026-10-14T16:00:00Z", cumulative_quantity: 200 },
    { by: "2026-10-15T16:00:00Z", cumulative_quantity: 600 },
  ],
  splitIncrementalCost: 7500,
  alternativeGross: 31200,
} as const;

export const HARBOR_PACK_FIXTURES = {
  "harbor-pack-canonical": {
    itemSku: "CARTON-302015",
    startingInventory: 600,
    phase: "awaiting_approval",
    severity: "urgent",
    firstShortageAt: HARBOR_PACK_EXPECTED.firstShortageAt,
    bridgeQuantity: HARBOR_PACK_EXPECTED.bridgeQuantity,
  },
  "harbor-pack-harmless": {
    itemSku: "CARTON-302015",
    startingInventory: 1500,
    phase: "monitoring",
    severity: "info",
    firstShortageAt: null,
    bridgeQuantity: null,
  },
} as const;

export const HARBOR_PACK_TIMES = {
  sourceAsOf: HARBOR_PACK_FIXTURE_CLOCK,
  originalDueAt: "2026-10-13T15:00:00.000Z",
  delayedArrivalAt: "2026-10-16T15:00:00.000Z",
  firstBridgeArrivalAt: "2026-10-14T15:00:00.000Z",
  quoteValidUntil: "2026-10-12T19:00:00.000Z",
  timeline: {
    delayReceivedAt: "2026-10-12T15:00:00.000Z",
    orderMatchedAt: "2026-10-12T15:02:00.000Z",
    stockRecalculatedAt: "2026-10-12T15:04:00.000Z",
    supplierRequestAt: "2026-10-12T15:10:00.000Z",
    offerVerifiedAt: "2026-10-12T15:12:00.000Z",
    planReadyAt: "2026-10-12T15:14:00.000Z",
  },
  demandAt: [
    "2026-10-13T16:00:00.000Z",
    "2026-10-14T16:00:00.000Z",
    "2026-10-15T16:00:00.000Z",
  ],
} as const;

export function buildHarborPackAssessmentProjection(
  fixtureId: HarborPackFixtureId,
  inventory: number,
) {
  const canonical = fixtureId === "harbor-pack-canonical";
  const points = canonical
    ? [
        { kind: "start", at: HARBOR_PACK_FIXTURE_CLOCK, delta: 600, balance: 600, sourceId: "inventory", label: "On hand" },
        { kind: "demand", at: HARBOR_PACK_TIMES.demandAt[0], delta: -400, balance: 200, sourceId: "DEMAND-1013", label: "Confirmed demand" },
        { kind: "demand", at: HARBOR_PACK_TIMES.demandAt[1], delta: -400, balance: -200, sourceId: "DEMAND-1014", label: "Confirmed demand" },
        { kind: "demand", at: HARBOR_PACK_TIMES.demandAt[2], delta: -400, balance: -600, sourceId: "DEMAND-1015", label: "Confirmed demand" },
        { kind: "receipt", at: HARBOR_PACK_TIMES.delayedArrivalAt, delta: 4000, balance: 3400, sourceId: "PO-1042-RECEIPT", label: "Confirmed delayed receipt" },
      ]
    : [
        { kind: "start", at: HARBOR_PACK_FIXTURE_CLOCK, delta: inventory, balance: inventory, sourceId: "inventory", label: "On hand" },
        ...HARBOR_PACK_TIMES.demandAt.map((at, index) => ({
          kind: "demand" as const,
          at,
          delta: -400,
          balance: inventory - 400 * (index + 1),
          sourceId: `DEMAND-101${3 + index}`,
          label: "Confirmed demand",
        })),
        { kind: "receipt", at: HARBOR_PACK_TIMES.delayedArrivalAt, delta: 4000, balance: inventory - 1200 + 4000, sourceId: "PO-1042-RECEIPT", label: "Confirmed delayed receipt" },
      ];
  const fixture = HARBOR_PACK_FIXTURES[fixtureId];
  return {
    points,
    firstShortageAt: canonical ? fixture.firstShortageAt : null,
    bridgeQuantity: canonical ? fixture.bridgeQuantity : null,
    datedRequirements: canonical
      ? HARBOR_PACK_EXPECTED.requirements.map((requirement) => ({
          by: requirement.by,
          cumulative_quantity: requirement.cumulative_quantity,
        }))
      : [],
  };
}
