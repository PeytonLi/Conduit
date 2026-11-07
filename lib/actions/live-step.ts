import type { LedgerFailure } from "./rpc";

/** Builds the payload for a live_connector plan step; registered by the business-system integration. */
export type LiveStepPreparer = (input: {
  orgId: string;
  stepPayload: Record<string, unknown>;
}) => Promise<{ ok: true; payload: unknown } | LedgerFailure>;

let preparer: LiveStepPreparer | null = null;

export function registerLiveStepPreparer(fn: LiveStepPreparer | null): void {
  preparer = fn;
}

export function getLiveStepPreparer(): LiveStepPreparer | null {
  return preparer;
}
