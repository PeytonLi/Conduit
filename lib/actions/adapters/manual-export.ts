import { asReplayAdapter, type ReplayAdapter } from "../replay";

/** A manual export hands an approved plan to a person. It is never reported as applied. */
export function createManualExportAdapter(): ReplayAdapter {
  return asReplayAdapter({
    kind: "manual_export",
    async dispatch(action) {
      return {
        outcome: "submitted",
        providerRef: `manual_handoff:${action.id}`,
        safeSummary: "Manual execution packet handed off; not applied until an owner records evidence",
      };
    },
    async findResult(action) {
      return {
        outcome: "unknown",
        providerRef: `manual_handoff:${action.id}`,
        safeSummary: "Manual execution has not been confirmed with evidence",
      };
    },
  });
}
