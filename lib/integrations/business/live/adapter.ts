import { z } from "zod";
import { ReplayViolationError } from "@/lib/actions/replay";
import type { ActionRecord, DispatchResult, ProviderAdapter, ReconcileResult } from "@/lib/actions/types";
import { amendDeliveryScheduleSchema } from "@/lib/integrations/business/amendment";
import { erpProviders } from "./registry";
import type { ResolvedErpClient } from "./resolve";
import { changeLookupSchema, deliverySplitResultSchema } from "./schemas";
import type { DeliverySplitRequest, ErpProvider } from "./types";

export const NOT_SUPPORTED_BY_PROVIDER = "not_supported_by_provider";

export const liveAmendmentPayloadSchema = amendDeliveryScheduleSchema.extend({
  erp: z
    .object({
      connection_id: z.string().uuid(),
      provider: z.enum(erpProviders as [ErpProvider, ...ErpProvider[]]),
      po_external_id: z.string().min(1),
      line_external_id: z.string().min(1),
      expected_version: z.string().min(1),
    })
    .strict(),
});

export type LiveAmendmentPayload = z.infer<typeof liveAmendmentPayloadSchema>;

export function toDeliverySplitRequest(actionId: string, payload: LiveAmendmentPayload): DeliverySplitRequest {
  return {
    change_ref: actionId,
    po_external_id: payload.erp.po_external_id,
    line_external_id: payload.erp.line_external_id,
    expected_version: payload.erp.expected_version,
    schedules: payload.schedules.map((s) => ({
      quantity: s.quantity,
      earliest_at: s.earliest_at,
      latest_at: s.latest_at,
    })),
  };
}

export interface LiveBusinessAdapterDeps {
  resolve(action: ActionRecord, connectionId: string): Promise<ResolvedErpClient>;
}

const failed = (errorCode: string, safeSummary: string): DispatchResult => ({ outcome: "failed", errorCode, safeSummary });

/**
 * Writes an approved delivery split to the connected business system. Nothing is reported
 * confirmed until findChange reads the change back; timeouts stay unknown for reconciliation.
 */
export function createLiveBusinessAdapter(deps: LiveBusinessAdapterDeps): ProviderAdapter {
  const ready = async (action: ActionRecord) => {
    if (action.mode === "replay") throw new ReplayViolationError(action.kind);
    const payload = liveAmendmentPayloadSchema.parse(action.payload);
    const resolved = await deps.resolve(action, payload.erp.connection_id);
    return { payload, resolved };
  };

  const readBack = async (
    client: Extract<ResolvedErpClient, { status: "ready" }>["client"],
    action: ActionRecord,
    poExternalId: string,
  ): Promise<ReconcileResult> => {
    const lookup = changeLookupSchema.parse(await client.findChange(action.id, poExternalId));
    if (lookup.status === "applied") {
      const total = lookup.deliveries.reduce((sum, d) => sum + d.quantity, 0);
      return {
        outcome: "confirmed",
        providerRef: lookup.provider_ref,
        safeSummary: `Business system shows the delivery split (${lookup.deliveries.length} deliveries, ${total} units)`,
      };
    }
    return { outcome: "unknown", safeSummary: "Business system does not show the change yet" };
  };

  return {
    kind: "live_business_amendment",
    async dispatch(action) {
      const { payload, resolved } = await ready(action);
      if (resolved.status !== "ready") return failed("connection_unavailable", resolved.reason);
      const client = resolved.client;
      const current = await client.readPurchaseOrder(payload.erp.po_external_id);
      if (!current) return failed("po_not_found", "Purchase order is no longer in the business system");
      if (!current.lines.some((l) => l.external_line_id === payload.erp.line_external_id)) {
        return failed("po_not_found", "Purchase order line is no longer in the business system");
      }
      if (current.version !== payload.erp.expected_version) {
        return failed("erp_conflict", "Purchase order changed in the business system since approval; nothing was written");
      }
      const result = deliverySplitResultSchema.parse(
        await client.applyDeliverySplit(toDeliverySplitRequest(action.id, payload)),
      );
      switch (result.status) {
        case "applied": {
          const confirmed = await readBack(client, action, payload.erp.po_external_id);
          return confirmed.outcome === "confirmed"
            ? confirmed
            : { outcome: "unknown", providerRef: result.provider_ref, safeSummary: "Write accepted but not yet read back" };
        }
        case "conflict":
          return failed("erp_conflict", "Purchase order changed in the business system; nothing was written");
        case "rejected":
          if (result.code === NOT_SUPPORTED_BY_PROVIDER) {
            return {
              outcome: "submitted",
              providerRef: `manual_handoff:${action.id}`,
              errorCode: NOT_SUPPORTED_BY_PROVIDER,
              safeSummary: `${resolved.connection.provider} cannot change purchase orders; manual execution packet handed off`,
            };
          }
          return failed("erp_rejected", `Business system rejected the change (${result.code.slice(0, 80)})`);
        case "unknown":
          return { outcome: "unknown", safeSummary: "Business system did not confirm the write" };
      }
    },
    async findResult(action) {
      const { payload, resolved } = await ready(action);
      if (resolved.status !== "ready") return { outcome: "unknown", safeSummary: resolved.reason };
      return readBack(resolved.client, action, payload.erp.po_external_id);
    },
  };
}
