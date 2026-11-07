import type { Clock, Rpc } from "@/lib/actions/rpc";
import type { LedgerFailure } from "@/lib/actions/rpc";
import { amendDeliveryScheduleSchema } from "@/lib/integrations/business/amendment";
import { liveAmendmentPayloadSchema, type LiveAmendmentPayload } from "./adapter";
import type { ResolvedErpClient } from "./resolve";
import { syncSnapshot } from "./sync";

export interface LiveStepDeps {
  rpc: Rpc;
  clock: Clock;
  resolve(orgId: string): Promise<ResolvedErpClient>;
}

/**
 * Refreshes the snapshot right before a live write, then pins the PO's provider identity and
 * version into the action payload. A refresh that changes business data supersedes the dataset,
 * so ledger_prepare_action rejects the stale approval and the case is re-assessed.
 */
export async function prepareLiveStepPayload(
  deps: LiveStepDeps,
  input: { orgId: string; stepPayload: Record<string, unknown> },
): Promise<{ ok: true; payload: LiveAmendmentPayload } | LedgerFailure> {
  const amendment = amendDeliveryScheduleSchema.safeParse({ change_kind: "amend_delivery_schedule", ...input.stepPayload });
  if (!amendment.success) {
    return { ok: false, code: "validation_failed", message: "Plan step is not a valid delivery amendment" };
  }
  const resolved = await deps.resolve(input.orgId);
  if (resolved.status !== "ready") {
    return { ok: false, code: "failed_precondition", message: resolved.reason, reason: resolved.status };
  }
  try {
    await syncSnapshot(deps, { orgId: input.orgId, connection: resolved.connection, client: resolved.client });
  } catch {
    return { ok: false, code: "failed_precondition", message: "Could not refresh data from the business system", reason: "refresh_failed" };
  }
  const ref = (await deps.rpc("erp_po_line_ref", {
    p: { org_id: input.orgId, po_line_id: amendment.data.po_line_id },
  })) as { po_external_id: string; line_external_id: string | null; source_version: string | null; connection_id: string | null } | null;
  if (!ref || !ref.line_external_id || !ref.source_version || ref.connection_id !== resolved.connection.connectionId) {
    return { ok: false, code: "failed_precondition", message: "This PO line did not come from the connected business system", reason: "not_from_connection" };
  }
  return {
    ok: true,
    payload: liveAmendmentPayloadSchema.parse({
      ...amendment.data,
      erp: {
        connection_id: resolved.connection.connectionId,
        provider: resolved.connection.provider,
        po_external_id: ref.po_external_id,
        line_external_id: ref.line_external_id,
        expected_version: ref.source_version,
      },
    }),
  };
}
