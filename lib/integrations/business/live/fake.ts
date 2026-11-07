import type { ErpClient, ErpPurchaseOrder, ErpReceipt, ErpSnapshot, AppliedDelivery } from "./types";

/** In-memory reference implementation of ErpClient used by tests and as a model for providers. */
export function createFakeErpClient(seed: { snapshot: ErpSnapshot }) {
  const pos = new Map<string, ErpPurchaseOrder>(seed.snapshot.purchase_orders.map((p) => [p.external_id, structuredClone(p)]));
  const changes = new Map<string, { po: string; deliveries: AppliedDelivery[] }>();
  const receipts: { receipt: ErpReceipt; recorded_at: string }[] = [];
  let tick = 0;
  const bump = (po: ErpPurchaseOrder) => {
    po.version = `v${++tick}`;
  };

  const client: ErpClient = {
    provider: "odoo",
    async readSnapshot() {
      return { ...structuredClone(seed.snapshot), as_of: new Date().toISOString(), purchase_orders: [...pos.values()].map((p) => structuredClone(p)) };
    },
    async readPurchaseOrder(id) {
      const po = pos.get(id);
      return po ? structuredClone(po) : null;
    },
    async applyDeliverySplit(req) {
      const existing = changes.get(req.change_ref);
      if (existing) return { status: "applied", provider_ref: `fake:${req.change_ref}`, version: pos.get(existing.po)!.version, deliveries: existing.deliveries };
      const po = pos.get(req.po_external_id);
      if (!po) return { status: "rejected", code: "not_found", message: "Purchase order not found" };
      if (po.version !== req.expected_version) return { status: "conflict", current_version: po.version, message: "Purchase order changed" };
      const index = po.lines.findIndex((l) => l.external_line_id === req.line_external_id);
      if (index < 0) return { status: "rejected", code: "not_found", message: "Line not found" };
      const line = po.lines[index];
      const open = line.ordered_qty - line.received_qty;
      if (req.schedules.reduce((s, d) => s + d.quantity, 0) !== open) {
        return { status: "rejected", code: "quantity_mismatch", message: "Schedules must cover the open quantity" };
      }
      const deliveries: AppliedDelivery[] = req.schedules.map((s, i) => {
        const external_ref = i === 0 ? line.external_line_id : `${line.external_line_id}-${req.change_ref}-${i}`;
        if (i === 0) {
          line.ordered_qty = line.received_qty + s.quantity;
          line.due_at = s.earliest_at;
        } else {
          po.lines.push({ ...line, external_line_id: external_ref, ordered_qty: s.quantity, received_qty: 0, due_at: s.earliest_at });
        }
        return { external_ref, quantity: s.quantity, due_at: s.earliest_at };
      });
      bump(po);
      changes.set(req.change_ref, { po: po.external_id, deliveries });
      return { status: "applied", provider_ref: `fake:${req.change_ref}`, version: po.version, deliveries };
    },
    async findChange(ref, poId) {
      const change = changes.get(ref);
      if (!change || change.po !== poId) return { status: "not_found" };
      return { status: "applied", provider_ref: `fake:${ref}`, deliveries: change.deliveries };
    },
    async listReceipts(since) {
      return receipts.filter((r) => !since || r.recorded_at >= since).map((r) => r.receipt);
    },
  };

  return {
    client,
    touch(poId: string) {
      bump(pos.get(poId)!);
    },
    receive(poId: string, lineId: string, quantity: number) {
      const line = pos.get(poId)!.lines.find((l) => l.external_line_id === lineId)!;
      line.received_qty += quantity;
      bump(pos.get(poId)!);
      const now = new Date().toISOString();
      receipts.push({
        receipt: { external_receipt_id: `rcpt-${receipts.length + 1}`, po_external_id: poId, line_external_id: lineId, quantity, received_at: now, kind: "received" },
        recorded_at: now,
      });
    },
  };
}
