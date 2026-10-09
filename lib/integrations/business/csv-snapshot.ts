import { buildManualExecutionPacket, type ManualPacketInput } from "./manual-packet";
import type { BusinessChangeRequest, BusinessConnector, BusinessSnapshotRequest } from "./types";

/**
 * CSV snapshot connector: read-only. Changes become a manual execution packet with status
 * manual_handoff; this connector never reports a change as applied.
 */
export function createCsvSnapshotConnector(): BusinessConnector {
  const readOnly = async (input: BusinessSnapshotRequest | BusinessChangeRequest) => ({
    status: "unsupported",
    org_id: input.orgId,
    reason: "CSV snapshots are imported through the dataset upload flow",
  });
  const handoff = async (input: BusinessChangeRequest) => {
    const packetInput = input.payload as ManualPacketInput;
    return { status: "manual_handoff" as const, applied: false, packet: buildManualExecutionPacket(packetInput) };
  };
  return {
    mode: "csv_snapshot",
    capabilities: { can_read: true, can_revalidate: false, can_write: false, can_reconcile: false, can_receive: false },
    readSnapshot: readOnly,
    refreshMaterialFacts: async (input) => ({
      status: "unsupported",
      org_id: input.orgId,
      reason: "CSV snapshots cannot be revalidated; upload a fresh snapshot",
    }),
    readReceipts: readOnly,
    prepareChange: handoff,
    applyApprovedChange: handoff,
    findChangeResult: async () => ({ status: "manual_handoff" as const, applied: false }),
  };
}
