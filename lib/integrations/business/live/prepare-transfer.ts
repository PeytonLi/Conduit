import { z } from "zod";
import type { LiveStepInfo } from "@/lib/actions/live-step";
import type { LedgerFailure } from "@/lib/actions/rpc";
import { buildProjectionInput, type ProjectionFacts } from "@/lib/domain/assessment-input";
import { checkTransferCoverage, transferCapabilityBlockers } from "@/lib/domain/transfers";
import { transferStockPayloadSchema } from "@/lib/integrations/business/transfer";
import { liveTransferPayloadSchema, type LiveTransferPayload } from "./transfer-adapter";
import type { LiveStepDeps } from "./prepare";
import { syncSnapshot } from "./sync";

const refSchema = z.object({
  item_external_id: z.string().min(1),
  source_location_external_id: z.string().min(1),
  destination_location_external_id: z.string().min(1),
  connection_id: z.string().uuid().nullable(),
});

const precondition = (message: string, reason: string): LedgerFailure => ({ ok: false, code: "failed_precondition", message, reason });

/**
 * Re-checks everything an approved transfer relied on, right before the write: the connection
 * must still be able to execute transfers, the snapshot is refreshed (a refresh that changes
 * business data supersedes the dataset, so ledger_prepare_action rejects the stale approval), and
 * the deterministic source-coverage rule runs again on the fresh stock and demand. Then pins the
 * provider identities and the stock floor the connector enforces against live stock.
 */
export async function prepareLiveTransferPayload(
  deps: LiveStepDeps,
  input: { orgId: string; stepPayload: Record<string, unknown>; step: LiveStepInfo },
): Promise<{ ok: true; payload: LiveTransferPayload } | LedgerFailure> {
  const terms = transferStockPayloadSchema.safeParse({ change_kind: "transfer_stock", ...input.stepPayload });
  if (!terms.success || input.step.quantity === null || input.step.quantity <= 0 || !input.step.destination_location_id) {
    return { ok: false, code: "validation_failed", message: "Plan step is not a valid stock transfer" };
  }
  const quantity = input.step.quantity;
  const destinationId = input.step.destination_location_id;
  if (terms.data.source_location_id === destinationId) {
    return { ok: false, code: "validation_failed", message: "Transfer source must differ from the destination" };
  }

  const resolved = await deps.resolve(input.orgId);
  if (resolved.status !== "ready") return precondition(resolved.reason, resolved.status);
  const api = resolved.client.transfers;
  if (!api) return precondition("The connected business system cannot execute transfers", "transfer_unsupported");
  if (transferCapabilityBlockers(api.capabilities).length > 0) {
    return precondition("The connected business system lacks reserve, dispatch or receiving support", "transfer_unsupported");
  }

  try {
    await syncSnapshot(deps, { orgId: input.orgId, connection: resolved.connection, client: resolved.client });
  } catch {
    return precondition("Could not refresh data from the business system", "refresh_failed");
  }

  const ref = refSchema.safeParse(
    await deps.rpc("erp_transfer_ref", {
      p: {
        org_id: input.orgId,
        item_id: input.step.item_id,
        source_location_id: terms.data.source_location_id,
        destination_location_id: destinationId,
      },
    }),
  );
  if (!ref.success || ref.data.connection_id !== resolved.connection.connectionId) {
    return precondition("These locations did not come from the connected business system", "not_from_connection");
  }

  const facts = (await deps.rpc("load_projection_facts", {
    p_org_id: input.orgId,
    p_item_id: input.step.item_id,
    p_location_id: terms.data.source_location_id,
  })) as ProjectionFacts;
  const { input: sourceInput } = buildProjectionInput(facts);
  if (!sourceInput) return precondition("Source stock is not known in the refreshed data", "source_facts_incomplete");
  const coverage = checkTransferCoverage(sourceInput, quantity, "transfer");
  if (!coverage.ok) {
    return {
      ok: false,
      code: "failed_precondition",
      message:
        coverage.code === "source_coverage_insufficient"
          ? `The source can now spare only ${coverage.maxSafeQuantity}; the approved transfer would leave it short`
          : "Source stock cannot be confirmed in the refreshed data",
      reason: coverage.code,
    };
  }

  return {
    ok: true,
    payload: liveTransferPayloadSchema.parse({
      ...terms.data,
      item_id: input.step.item_id,
      destination_location_id: destinationId,
      quantity,
      erp: {
        connection_id: resolved.connection.connectionId,
        provider: resolved.connection.provider,
        item_external_id: ref.data.item_external_id,
        source_location_external_id: ref.data.source_location_external_id,
        destination_location_external_id: ref.data.destination_location_external_id,
        min_source_on_hand_after: coverage.sourceFloorQuantity,
        source_max_safe_qty: coverage.maxSafeQuantity,
        source_physical_qty: sourceInput.physicalQty,
        source_as_of: sourceInput.t0,
      },
    }),
  };
}
