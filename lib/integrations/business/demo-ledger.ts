import { callLedger, type Clock, type Rpc } from "@/lib/actions/rpc";
import { amendDeliveryScheduleSchema } from "./amendment";
import type {
  BusinessChangeRequest,
  BusinessConnector,
  BusinessSnapshotRequest,
  MaterialFactsRequest,
} from "./types";

export const DEMO_LEDGER_LABEL = "DEMO LEDGER - simulated business system, not a live ERP";

export type DemoChangeResult =
  | { status: "applied"; label: string; entry_id: string; replayed: boolean }
  | { status: "rejected"; label: string; code: string; message: string };

export type DemoFindResult =
  | {
      status: "applied";
      label: string;
      entry_id: string;
      payload_hash: string;
      applied_at: string;
      schedules: { id: string; quantity: number; earliest_at: string; latest_at: string }[];
    }
  | { status: "not_found"; label: string };

/** Simulated business system (mode demo_ledger). Usable only in replay/sandbox; never live. */
export function createDemoLedgerConnector(deps: { rpc: Rpc; clock: Clock }): BusinessConnector {
  const unsupported = async (input: BusinessSnapshotRequest | MaterialFactsRequest) => ({
    status: "unsupported",
    label: DEMO_LEDGER_LABEL,
    org_id: input.orgId,
    reason: "Demo ledger snapshots are loaded through the Harbor Pack fixture import",
  });

  return {
    mode: "demo_ledger",
    capabilities: { can_read: true, can_revalidate: true, can_write: true, can_reconcile: true, can_receive: true },
    readSnapshot: unsupported,
    refreshMaterialFacts: unsupported,
    readReceipts: unsupported,
    async prepareChange(input: BusinessChangeRequest) {
      const parsed = amendDeliveryScheduleSchema.safeParse(input.payload);
      if (!parsed.success) {
        return { status: "rejected", label: DEMO_LEDGER_LABEL, code: "validation_failed", message: "Invalid change" };
      }
      return { status: "prepared", label: DEMO_LEDGER_LABEL, change: parsed.data };
    },
    async applyApprovedChange(input: BusinessChangeRequest): Promise<DemoChangeResult> {
      const result = await callLedger<{ entry_id: string; label: string; replayed: boolean }>(
        deps.rpc,
        "demo_ledger_apply",
        { p_org_id: input.orgId, p_action_id: input.actionId, p_now: deps.clock.now().toISOString() },
      );
      if (!result.ok) {
        return { status: "rejected", label: DEMO_LEDGER_LABEL, code: result.code, message: result.message };
      }
      return { status: "applied", label: result.label, entry_id: result.entry_id, replayed: result.replayed };
    },
    async findChangeResult(input: BusinessChangeRequest): Promise<DemoFindResult> {
      const result = await callLedger<{
        found: boolean;
        entry_id: string;
        label: string;
        payload_hash: string;
        applied_at: string;
        schedules: { id: string; quantity: number; earliest_at: string; latest_at: string }[];
      }>(deps.rpc, "demo_ledger_find", { p_org_id: input.orgId, p_action_id: input.actionId });
      if (!result.ok || !result.found) return { status: "not_found", label: DEMO_LEDGER_LABEL };
      return {
        status: "applied",
        label: result.label,
        entry_id: result.entry_id,
        payload_hash: result.payload_hash,
        applied_at: result.applied_at,
        schedules: result.schedules,
      };
    },
  };
}
