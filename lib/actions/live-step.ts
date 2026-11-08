import type { LedgerFailure } from "./rpc";
import type { ActionKind } from "./types";

/** The plan step being executed; lets one preparer serve every live step kind. */
export interface LiveStepInfo {
  kind: string;
  quantity: number | null;
  item_id: string;
  destination_location_id: string | null;
}

/** Builds the payload for a live_connector plan step; registered by the business-system integration. */
export type LiveStepPreparer = (input: {
  orgId: string;
  stepPayload: Record<string, unknown>;
  step?: LiveStepInfo;
}) => Promise<{ ok: true; payload: unknown; kind?: ActionKind } | LedgerFailure>;

let preparer: LiveStepPreparer | null = null;

export function registerLiveStepPreparer(fn: LiveStepPreparer | null): void {
  preparer = fn;
}

export function getLiveStepPreparer(): LiveStepPreparer | null {
  return preparer;
}

export type TransferGateResult =
  | { mode: "execute"; provider: string; connectionId: string }
  | { mode: "recommend_only"; provider: string | null; code: string; reason: string };

/** Whether the org's connected business system can execute an internal transfer right now. */
export type TransferGate = (orgId: string) => Promise<TransferGateResult>;

let transferGate: TransferGate | null = null;

export function registerTransferGate(fn: TransferGate | null): void {
  transferGate = fn;
}

export function getTransferGate(): TransferGate | null {
  return transferGate;
}
