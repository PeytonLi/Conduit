export interface ProjectionInput {
  t0: string;
  timezone: string;
  unit: string;
  horizonEnd: string;
  physicalQty: number;
  unusableQty: number;
  outsideAllocationsQty: number;
  safetyBufferQty: number;
  receipts: {
    id: string;
    quantity: number;
    earliestAt: string | null;
    latestAt: string | null;
    dateOnly: boolean;
    promiseState: "confirmed" | "estimated" | "unknown";
    evidenceIds: string[];
  }[];
  demand: {
    id: string;
    quantity: number;
    requiredAt: string;
    certainty: "confirmed" | "forecast";
    includedReservedQty: number;
  }[];
  pendingClaims: { id: string; quantity: number }[];
}

export interface ProjectionPoint {
  at: string;
  kind: "start" | "receipt" | "demand";
  delta: number;
  balance: number;
  sourceId: string | null;
}

export interface ProjectionResult {
  quality: "sufficient" | "insufficient";
  missingFacts: string[];
  points: ProjectionPoint[];
  firstShortageAt: string | null;
  bridgeQuantity: number | null;
  requirements: { by: string; cumulativeQuantity: number }[];
  inputFingerprint: string;
}
