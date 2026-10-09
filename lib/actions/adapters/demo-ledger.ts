import type { BusinessConnector } from "@/lib/integrations/business/types";
import type { DemoChangeResult, DemoFindResult } from "@/lib/integrations/business/demo-ledger";
import { asReplayAdapter, type ReplayAdapter } from "../replay";
import type { ActionRecord, DispatchResult } from "../types";

/** Writes an approved amendment to the DEMO LEDGER and confirms it by reading it back. */
export function createDemoLedgerAdapter(connector: BusinessConnector): ReplayAdapter {
  if (connector.mode !== "demo_ledger") {
    throw new Error("Demo ledger adapter requires the demo_ledger connector");
  }
  const request = (action: ActionRecord) => ({
    orgId: action.orgId,
    caseId: action.caseId,
    actionId: action.id,
    expectedVersion: 0,
    payload: action.payload,
  });
  const readBack = async (action: ActionRecord): Promise<DispatchResult> => {
    const found = (await connector.findChangeResult(request(action))) as DemoFindResult;
    if (found.status === "applied" && found.payload_hash === action.payloadHash) {
      return {
        outcome: "confirmed",
        providerRef: `demo_ledger:${found.entry_id}`,
        safeSummary: "Demo ledger delivery schedule amended (simulated business system)",
      };
    }
    return { outcome: "unknown", safeSummary: "Demo ledger change not visible on readback" };
  };
  return asReplayAdapter({
    kind: "demo_ledger_amendment",
    async dispatch(action) {
      const applied = (await connector.applyApprovedChange(request(action))) as DemoChangeResult;
      if (applied.status === "rejected") {
        if (applied.code === "precondition_failed" || applied.code === "validation_failed") {
          return { outcome: "failed", safeSummary: "Demo ledger rejected the change; nothing was applied" };
        }
        return { outcome: "unknown", safeSummary: "Demo ledger write outcome is uncertain" };
      }
      return readBack(action);
    },
    async findResult(action) {
      const result = await readBack(action);
      return { ...result, outcome: result.outcome === "confirmed" ? "confirmed" : "unknown" };
    },
  });
}
