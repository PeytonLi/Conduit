import { z } from "zod";
import { ReplayViolationError } from "@/lib/actions/replay";
import type { ActionRecord, DispatchResult, ProviderAdapter, ReconcileResult } from "@/lib/actions/types";
import { transferStockPayloadSchema } from "@/lib/integrations/business/transfer";
import { erpProviders } from "./registry";
import type { ResolvedErpClient } from "./resolve";
import type { ErpProvider, TransferLookup, TransferRecord, TransferRequest } from "./types";

const qty = z.number().int().min(0).max(1_000_000_000);

/** Action payload: the approved plan step plus the provider identities and stock floor pinned at prepare time. */
export const liveTransferPayloadSchema = transferStockPayloadSchema
  .extend({
    item_id: z.string().uuid(),
    destination_location_id: z.string().uuid(),
    quantity: z.number().int().positive().max(1_000_000_000),
    erp: z
      .object({
        connection_id: z.string().uuid(),
        provider: z.enum(erpProviders as [ErpProvider, ...ErpProvider[]]),
        item_external_id: z.string().min(1),
        source_location_external_id: z.string().min(1),
        destination_location_external_id: z.string().min(1),
        /** Stock that has to stay at the source: its physical stock minus the largest safe transfer. */
        min_source_on_hand_after: qty,
        source_max_safe_qty: qty,
        source_physical_qty: qty,
        source_as_of: z.string().datetime({ offset: true }),
      })
      .strict(),
  })
  .strict();

export type LiveTransferPayload = z.infer<typeof liveTransferPayloadSchema>;

export function toTransferRequest(actionId: string, payload: LiveTransferPayload): TransferRequest {
  return {
    change_ref: actionId,
    item_external_id: payload.erp.item_external_id,
    source_location_external_id: payload.erp.source_location_external_id,
    destination_location_external_id: payload.erp.destination_location_external_id,
    quantity: payload.quantity,
    arrives_at: payload.arrival_end,
    min_source_on_hand_after: payload.erp.min_source_on_hand_after,
  };
}

export interface LiveTransferAdapterDeps {
  resolve(action: ActionRecord, connectionId: string): Promise<ResolvedErpClient>;
}

const failed = (errorCode: string, safeSummary: string): DispatchResult => ({ outcome: "failed", errorCode, safeSummary });

const stateLabel: Record<TransferRecord["state"], string> = {
  reserved: "reserved at the source, not dispatched",
  in_transit: "dispatched and in transit",
  partially_received: "partly received at the destination",
  received: "received at the destination",
  cancelled: "cancelled in the business system",
};

/** Maps what the business system shows to a ledger outcome. Only a dispatched transfer counts as confirmed. */
export function outcomeForLookup(lookup: TransferLookup, providerLabel: string): ReconcileResult {
  if (lookup.status === "not_found") {
    return { outcome: "unknown", safeSummary: `${providerLabel} does not show the transfer yet` };
  }
  const detail = `${lookup.quantity} units ${stateLabel[lookup.state]}${lookup.received_qty > 0 ? ` (${lookup.received_qty} received)` : ""}`;
  switch (lookup.state) {
    case "in_transit":
    case "partially_received":
    case "received":
      return { outcome: "confirmed", providerRef: lookup.provider_ref, safeSummary: `${providerLabel} shows the transfer: ${detail}` };
    case "cancelled":
      return { outcome: "failed", providerRef: lookup.provider_ref, errorCode: "transfer_cancelled", safeSummary: `${providerLabel} shows the transfer ${stateLabel.cancelled}` };
    case "reserved":
      return {
        outcome: "unknown",
        providerRef: lookup.provider_ref,
        safeSummary: `${providerLabel} shows the transfer ${stateLabel.reserved}; an owner has to dispatch or cancel it there`,
      };
  }
}

/**
 * Executes an approved internal stock transfer in the connected business system. The action
 * exists before this runs; the client stamps the action id on what it creates so an unknown
 * result is settled by reading the system, never by writing again.
 */
export function createLiveTransferAdapter(deps: LiveTransferAdapterDeps): ProviderAdapter {
  const ready = async (action: ActionRecord) => {
    if (action.mode === "replay") throw new ReplayViolationError(action.kind);
    const payload = liveTransferPayloadSchema.parse(action.payload);
    const resolved = await deps.resolve(action, payload.erp.connection_id);
    return { payload, resolved };
  };

  return {
    kind: "live_business_transfer",

    async dispatch(action) {
      const { payload, resolved } = await ready(action);
      if (resolved.status !== "ready") return failed("connection_unavailable", resolved.reason);
      const api = resolved.client.transfers;
      if (!api) {
        return failed("transfer_not_supported", `${resolved.connection.provider} cannot execute internal transfers; nothing was written`);
      }
      const label = resolved.connection.provider;
      const result = await api.createTransfer(toTransferRequest(action.id, payload));
      switch (result.status) {
        case "applied": {
          const { status: _status, ...record } = result;
          void _status;
          return outcomeForLookup({ status: "found", ...record }, label);
        }
        case "rejected":
          return failed(
            result.code === "source_stock_changed" || result.code === "source_stock_unavailable" ? result.code : "erp_rejected",
            result.code === "source_stock_changed" || result.code === "source_stock_unavailable"
              ? `Source stock changed since approval; nothing was written (${result.code})`
              : `Business system rejected the transfer (${result.code.slice(0, 80)}); nothing was written`,
          );
        case "unknown":
          return { outcome: "unknown", safeSummary: `Business system did not confirm the transfer: ${result.message.slice(0, 200)}` };
      }
    },

    async findResult(action) {
      const { resolved } = await ready(action);
      if (resolved.status !== "ready") return { outcome: "unknown", safeSummary: resolved.reason };
      const api = resolved.client.transfers;
      if (!api) return { outcome: "unknown", safeSummary: `${resolved.connection.provider} cannot read back internal transfers` };
      return outcomeForLookup(await api.findTransfer(action.id, action.providerRef), resolved.connection.provider);
    },
  };
}
