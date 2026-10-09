import { asReplayAdapter, type ReplayAdapter } from "../replay";
import type { ActionRecord } from "../types";

/**
 * REPLAY ONLY: records a supplier email/call as simulated. Nothing leaves the system; the
 * provider reference is a deterministic replay id so retries reconcile to the same result.
 */
export function createReplayOutreachAdapter(kind: "supplier_email" | "supplier_call"): ReplayAdapter {
  const ref = (action: ActionRecord) => `replay:${kind}:${action.id}`;
  return asReplayAdapter({
    kind,
    async dispatch(action) {
      return { outcome: "submitted", providerRef: ref(action), safeSummary: `Replay ${kind} recorded; no supplier contacted` };
    },
    async findResult(action) {
      return { outcome: "confirmed", providerRef: ref(action), safeSummary: `Replay ${kind} delivered (simulated)` };
    },
  });
}
