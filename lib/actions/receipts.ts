import { z } from "zod";
import { callLedger, type Clock, type Rpc } from "./rpc";

export const receiptInputSchema = z
  .object({
    po_line_id: z.string().uuid(),
    external_receipt_id: z.string().trim().min(1).max(200),
    quantity: z.number().int().positive().max(1_000_000_000),
    received_at: z.string().datetime({ offset: true }),
    kind: z.enum(["received", "reversal"]).default("received"),
    reverses_external_id: z.string().trim().min(1).max(200).optional(),
    evidence_id: z.string().uuid().optional(),
  })
  .strict();

/** Records a partial/full receipt (or reversal) idempotently by its stable source receipt id. */
export function recordReceipt(
  deps: { rpc: Rpc; clock: Clock },
  input: { orgId: string; actorId: string; receipt: z.input<typeof receiptInputSchema> },
) {
  const r = receiptInputSchema.parse(input.receipt);
  return callLedger<{ duplicate: boolean; receipt_event_id: string; affected_case_ids?: string[]; reopened_case_ids?: string[] }>(
    deps.rpc,
    "record_receipt",
    {
      p_org_id: input.orgId,
      p_actor_id: input.actorId,
      p_po_line_id: r.po_line_id,
      p_external_receipt_id: r.external_receipt_id,
      p_quantity: r.quantity,
      p_received_at: r.received_at,
      p_kind: r.kind,
      p_reverses_external_id: r.reverses_external_id ?? null,
      p_evidence_id: r.evidence_id ?? null,
      p_now: deps.clock.now().toISOString(),
    },
  );
}

export function deliveryStatus(deps: { rpc: Rpc }, orgId: string, caseId: string) {
  return callLedger<{ delivered: boolean; lines: { po_line_id: string; open_qty: number; evidenced_received_qty: number }[] }>(
    deps.rpc,
    "case_delivery_status",
    { p_org_id: orgId, p_case_id: caseId },
  );
}

/** Closes a monitored case as delivered only when receiving evidence covers every open line. */
export function markDelivered(deps: { rpc: Rpc; clock: Clock }, orgId: string, caseId: string, actorId: string) {
  return callLedger<{ case_id: string; closed_outcome: "delivered" }>(deps.rpc, "case_mark_delivered", {
    p_org_id: orgId,
    p_case_id: caseId,
    p_actor_id: actorId,
    p_now: deps.clock.now().toISOString(),
  });
}

export function monitorPoLineDelivery(deps: { rpc: Rpc; clock: Clock }, orgId: string, poLineId: string) {
  return callLedger<{ delivered_case_ids: string[] }>(deps.rpc, "monitor_po_line_delivery", {
    p_org_id: orgId,
    p_po_line_id: poLineId,
    p_now: deps.clock.now().toISOString(),
  });
}
