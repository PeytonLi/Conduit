import { currencyMinorDigits } from "@/lib/domain/money";
import type {
  AppliedDelivery,
  ChangeLookup,
  DeliverySplitRequest,
  DeliverySplitResult,
  ErpClient,
  ErpPurchaseOrder,
  ErpReceipt,
  ErpSnapshot,
} from "../types";
import { QBO_STALE_OBJECT, QboFaultError, QboTransportError, qboLiteral, qboRequestId, type QboHttp } from "./http";
import type { QboBill, QboLine, QboPurchaseOrder } from "./schemas";

/** QBO inventory has one quantity per item, so the company is the only location. */
export const QBO_LOCATION_ID = "qbo-company";
const ITEM_LINE = "ItemBasedExpenseLineDetail";
const REF_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const MARKER = /conduit-change:([A-Za-z0-9._-]+):(\d+|r)\/(\d+)(?::line=([^:\s]+))?(?::base=(\d+))?/g;

interface Marker {
  ref: string;
  part: number | "r";
  parts: number;
  lineId?: string;
  base?: number;
}

export function parseMarkers(note: string | undefined): Marker[] {
  return [...(note ?? "").matchAll(MARKER)].map((m) => ({
    ref: m[1],
    part: m[2] === "r" ? "r" : Number(m[2]),
    parts: Number(m[3]),
    lineId: m[4],
    base: m[5] === undefined ? undefined : Number(m[5]),
  }));
}

/** Later deliveries live on new POs numbered 1..n; part 0 is the delivery kept on the original. */
const laterCount = (m: Marker) => (m.part === 0 ? m.parts - 1 : m.parts);

function wholeUnits(value: number | undefined, label: string): number {
  const qty = value ?? 0;
  if (!Number.isSafeInteger(qty) || qty < 0) throw new Error(`QuickBooks ${label} is not a whole, non-negative number`);
  return qty;
}

function toMinor(value: number | undefined, currency: string): string {
  return BigInt(Math.round((value ?? 0) * 10 ** currencyMinorDigits(currency))).toString();
}

function amount(qty: number, unitPrice: number | undefined, currency: string): number {
  return Number((qty * (unitPrice ?? 0)).toFixed(currencyMinorDigits(currency)));
}

/** QBO dates have no time; Conduit reads them as midnight UTC. */
const dueAt = (date: string | undefined) => (date ? `${date.slice(0, 10)}T00:00:00.000Z` : null);
const qboDate = (iso: string) => new Date(iso).toISOString().slice(0, 10);
const qboTime = (iso: string) => new Date(iso).toISOString().replace(/\.\d{3}Z$/, "+00:00");
const lineKey = (poId: string, lineId: string) => `${poId}:${lineId}`;
const itemLines = (po: QboPurchaseOrder) => po.Line.filter((l) => l.DetailType === ITEM_LINE && l.ItemBasedExpenseLineDetail);
const currencyOf = (po: QboPurchaseOrder) => po.CurrencyRef?.value ?? "USD";

function linkedBillIds(pos: QboPurchaseOrder[]): string[] {
  return [...new Set(pos.flatMap((po) => (po.LinkedTxn ?? []).filter((t) => t.TxnType === "Bill").map((t) => t.TxnId)))];
}

function billedQty(bills: QboBill[], poId: string, lineId: string): number {
  let total = 0;
  for (const bill of bills) {
    for (const line of bill.Line) {
      const linked = line.LinkedTxn?.some((t) => t.TxnType === "PurchaseOrder" && t.TxnId === poId && t.TxnLineId === lineId);
      if (linked) total += wholeUnits(line.ItemBasedExpenseLineDetail?.Qty, "bill quantity");
    }
  }
  return total;
}

export function createQuickbooksClient(http: QboHttp, deps: { now: () => Date }): ErpClient {
  async function billsFor(pos: QboPurchaseOrder[]): Promise<QboBill[]> {
    const ids = linkedBillIds(pos);
    const bills: QboBill[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      bills.push(...(await http.query("Bill", `Id in (${ids.slice(i, i + 100).map(qboLiteral).join(", ")})`)));
    }
    return bills;
  }

  function toErp(po: QboPurchaseOrder, bills: QboBill[]): ErpPurchaseOrder {
    const currency = currencyOf(po);
    return {
      external_id: po.Id,
      supplier_external_id: po.VendorRef.value,
      currency,
      status: (po.POStatus ?? "Open").toLowerCase(),
      version: po.SyncToken,
      lines: itemLines(po).map((line) => {
        const detail = line.ItemBasedExpenseLineDetail!;
        const ordered = wholeUnits(detail.Qty, "PO line quantity");
        return {
          external_line_id: lineKey(po.Id, line.Id ?? ""),
          item_external_id: detail.ItemRef.value,
          ordered_qty: ordered,
          received_qty: Math.min(ordered, billedQty(bills, po.Id, line.Id ?? "")),
          unit_price_minor: toMinor(detail.UnitPrice, currency),
          due_at: dueAt(po.DueDate),
          destination_external_id: QBO_LOCATION_ID,
        };
      }),
    };
  }

  async function laterParts(po: QboPurchaseOrder, ref: string): Promise<Map<number, QboPurchaseOrder>> {
    const created = po.MetaData?.CreateTime;
    const found = new Map<number, QboPurchaseOrder>();
    for (const candidate of await http.query("PurchaseOrder", created ? `MetaData.CreateTime >= ${qboLiteral(created)}` : "")) {
      if (candidate.Id === po.Id || candidate.VendorRef.value !== po.VendorRef.value) continue;
      for (const marker of parseMarkers(candidate.PrivateNote)) {
        if (marker.ref === ref && typeof marker.part === "number" && !found.has(marker.part)) found.set(marker.part, candidate);
      }
    }
    return found;
  }

  async function lookup(ref: string, po: QboPurchaseOrder): Promise<ChangeLookup> {
    const marker = parseMarkers(po.PrivateNote).find((m) => m.ref === ref);
    if (!marker) return { status: "not_found" };
    const deliveries: AppliedDelivery[] = [];
    if (marker.part === 0) {
      const line = itemLines(po).find((l) => l.Id === marker.lineId);
      if (!line) return { status: "not_found" };
      deliveries.push({
        external_ref: lineKey(po.Id, line.Id!),
        quantity: wholeUnits(line.ItemBasedExpenseLineDetail!.Qty, "PO line quantity") - (marker.base ?? 0),
        due_at: dueAt(po.DueDate),
      });
    }
    const parts = await laterParts(po, ref);
    for (let i = 1; i <= laterCount(marker); i++) {
      const part = parts.get(i);
      const line = part && itemLines(part)[0];
      // A crash between the original update and a later create leaves a partial change; re-applying
      // the same change_ref finishes it, so only a complete change is reported as applied.
      if (!part || !line) return { status: "not_found" };
      deliveries.push({
        external_ref: lineKey(part.Id, line.Id ?? ""),
        quantity: wholeUnits(line.ItemBasedExpenseLineDetail!.Qty, "PO line quantity"),
        due_at: dueAt(part.DueDate),
      });
    }
    return { status: "applied", provider_ref: `quickbooks:${po.Id}:${ref}`, deliveries };
  }

  async function currentVersion(poId: string): Promise<string | null> {
    try {
      return (await http.read("PurchaseOrder", poId))?.SyncToken ?? null;
    } catch {
      return null;
    }
  }

  async function split(req: DeliverySplitRequest): Promise<DeliverySplitResult> {
    if (!REF_PATTERN.test(req.change_ref)) return { status: "rejected", code: "invalid_change_ref", message: "change_ref must be 1-100 letters, digits, dot, dash or underscore" };
    if (!req.schedules.length || req.schedules.some((s) => !Number.isSafeInteger(s.quantity) || s.quantity <= 0 || Number.isNaN(Date.parse(s.latest_at)))) {
      return { status: "rejected", code: "invalid_schedule", message: "Each delivery needs a positive whole quantity and a valid date" };
    }
    const po = await http.read("PurchaseOrder", req.po_external_id);
    if (!po) return { status: "rejected", code: "not_found", message: "Purchase order not found" };
    const [poId, lineId] = req.line_external_id.split(":");
    const line = poId === po.Id ? itemLines(po).find((l) => l.Id === lineId) : undefined;
    if (!line) return { status: "rejected", code: "not_found", message: "Line not found" };

    const schedules = [...req.schedules].sort((a, b) => Date.parse(a.latest_at) - Date.parse(b.latest_at));
    const keepFirst = itemLines(po).length === 1;
    const existing = parseMarkers(po.PrivateNote).find((m) => m.ref === req.change_ref);
    let original = po;

    if (!existing) {
      if (po.SyncToken !== req.expected_version) return { status: "conflict", current_version: po.SyncToken, message: "Purchase order changed in QuickBooks" };
      if ((po.POStatus ?? "Open") !== "Open") return { status: "rejected", code: "closed", message: "Purchase order is closed in QuickBooks" };
      const detail = line.ItemBasedExpenseLineDetail!;
      const ordered = wholeUnits(detail.Qty, "PO line quantity");
      const received = Math.min(ordered, billedQty(await billsFor([po]), po.Id, line.Id!));
      if (schedules.reduce((s, d) => s + d.quantity, 0) !== ordered - received) {
        return { status: "rejected", code: "quantity_mismatch", message: "Schedules must cover the open quantity" };
      }
      const marker = keepFirst
        ? `conduit-change:${req.change_ref}:0/${schedules.length}:line=${line.Id}:base=${received}`
        : `conduit-change:${req.change_ref}:r/${schedules.length}`;
      const note = [po.PrivateNote, marker].filter(Boolean).join("\n");
      if (note.length > 4000) return { status: "rejected", code: "note_full", message: "Purchase order memo is full" };
      const currency = currencyOf(po);
      const nextQty = keepFirst ? received + schedules[0].quantity : received;
      const lines: QboLine[] = po.Line.flatMap((l) => {
        if (l !== line) return [l];
        if (nextQty === 0) return [];
        return [{ ...l, Amount: amount(nextQty, detail.UnitPrice, currency), ItemBasedExpenseLineDetail: { ...detail, Qty: nextQty } }];
      });
      try {
        original = await http.write(
          "PurchaseOrder",
          {
            Id: po.Id,
            SyncToken: po.SyncToken,
            sparse: true,
            Line: lines,
            PrivateNote: note,
            ...(keepFirst ? { DueDate: qboDate(schedules[0].latest_at) } : {}),
          },
          qboRequestId(req.change_ref, po.Id, "original"),
        );
      } catch (err) {
        if (err instanceof QboFaultError && err.codes.includes(QBO_STALE_OBJECT)) {
          return { status: "conflict", current_version: await currentVersion(po.Id), message: "QuickBooks rejected a stale SyncToken" };
        }
        if (err instanceof QboFaultError) return { status: "rejected", code: `qbo_${err.codes[0] || err.status}`, message: err.message };
        return { status: "unknown", message: err instanceof Error ? err.message : "QuickBooks write outcome unknown" };
      }
    }

    const marker = existing ?? parseMarkers(original.PrivateNote).find((m) => m.ref === req.change_ref)!;
    const total = marker.parts;
    const have = await laterParts(original, req.change_ref);
    const template = existing ? itemLines(original).find((l) => l.Id === marker.lineId) ?? line : line;
    const detail = template.ItemBasedExpenseLineDetail!;
    for (let part = 1; part <= laterCount(marker); part++) {
      if (have.has(part)) continue;
      const schedule = schedules[marker.part === 0 ? part : part - 1];
      if (!schedule) return { status: "rejected", code: "schedule_mismatch", message: "Retry schedules do not match the original change" };
      const currency = currencyOf(original);
      const doc = original.DocNumber ? `${original.DocNumber}-${part + 1}` : undefined;
      try {
        await http.write(
          "PurchaseOrder",
          {
            VendorRef: original.VendorRef,
            ...pickDefined(original, ["APAccountRef", "CurrencyRef", "VendorAddr", "ShipAddr", "ShipMethodRef", "ClassRef", "SalesTermRef", "GlobalTaxCalculation", "TxnDate"]),
            ...(doc && doc.length <= 21 ? { DocNumber: doc } : {}),
            DueDate: qboDate(schedule.latest_at),
            POStatus: "Open",
            PrivateNote: `Split from PO ${original.DocNumber ?? original.Id} by Conduit.\nconduit-change:${req.change_ref}:${part}/${total}`,
            Line: [
              {
                DetailType: ITEM_LINE,
                Amount: amount(schedule.quantity, detail.UnitPrice, currency),
                ...(template.Description ? { Description: template.Description } : {}),
                ItemBasedExpenseLineDetail: { ...detail, Qty: schedule.quantity },
              },
            ],
          },
          qboRequestId(req.change_ref, original.Id, String(part)),
        );
      } catch (err) {
        if (err instanceof QboTransportError) return { status: "unknown", message: err.message };
        if (err instanceof QboFaultError) return { status: "rejected", code: `qbo_${err.codes[0] || err.status}`, message: `Original PO was reduced but the split PO failed: ${err.message}. Retry the same change_ref.` };
        throw err;
      }
    }

    const fresh = (await http.read("PurchaseOrder", original.Id)) ?? original;
    const found = await lookup(req.change_ref, fresh);
    if (found.status !== "applied") return { status: "unknown", message: "QuickBooks accepted the writes but the readback is incomplete" };
    return { status: "applied", provider_ref: found.provider_ref, version: fresh.SyncToken, deliveries: found.deliveries };
  }

  return {
    provider: "quickbooks",
    async readSnapshot(): Promise<ErpSnapshot> {
      const asOf = deps.now().toISOString();
      const [company, items, vendors, allPos] = await Promise.all([
        http.read("CompanyInfo", http.credentials.realm_id),
        http.query("Item", "Type = 'Inventory'"),
        http.query("Vendor", ""),
        // POStatus is not a documented query filter, so open POs are picked out here.
        http.query("PurchaseOrder", ""),
      ]);
      const pos = allPos.filter((po) => (po.POStatus ?? "Open") === "Open");
      const bills = await billsFor(pos);
      return {
        as_of: asOf,
        locations: [{ external_id: QBO_LOCATION_ID, name: company?.CompanyName ?? "QuickBooks company" }],
        items: items.map((item) => ({ external_id: item.Id, sku: item.Sku || item.Name, name: item.Name, unit: "each" })),
        suppliers: vendors.map((v) => ({
          external_id: v.Id,
          name: v.DisplayName,
          email: v.PrimaryEmailAddr?.Address ?? null,
          phone: v.PrimaryPhone?.FreeFormNumber ?? null,
        })),
        purchase_orders: pos.map((po) => toErp(po, bills)),
        stock: items
          .filter((item) => item.TrackQtyOnHand !== false)
          .map((item) => ({ item_external_id: item.Id, location_external_id: QBO_LOCATION_ID, on_hand_qty: Math.max(0, Math.floor(item.QtyOnHand ?? 0)) })),
        // QuickBooks has no demand source Conduit can read (no sales orders or work orders).
        demand: [],
      };
    },
    async readPurchaseOrder(id) {
      const po = await http.read("PurchaseOrder", id);
      return po ? toErp(po, await billsFor([po])) : null;
    },
    applyDeliverySplit: split,
    async findChange(ref, poId) {
      const po = await http.read("PurchaseOrder", poId);
      return po ? lookup(ref, po) : { status: "not_found" };
    },
    /**
     * QBO has no receiving API: a Bill line linked to a PO line is the only signal. Edited bills
     * re-emit the same receipt id with the new quantity; deleted bills are not reported.
     */
    async listReceipts(since): Promise<ErpReceipt[]> {
      const bills = await http.query("Bill", since ? `MetaData.LastUpdatedTime >= ${qboLiteral(qboTime(since))}` : "");
      return bills.flatMap((bill) =>
        bill.Line.flatMap((line) =>
          (line.LinkedTxn ?? [])
            .filter((t) => t.TxnType === "PurchaseOrder" && t.TxnLineId)
            .map((t) => ({
              external_receipt_id: `bill:${bill.Id}:${line.Id ?? ""}`,
              po_external_id: t.TxnId,
              line_external_id: lineKey(t.TxnId, t.TxnLineId!),
              quantity: wholeUnits(line.ItemBasedExpenseLineDetail?.Qty, "bill quantity"),
              received_at: new Date(bill.MetaData?.CreateTime ?? `${bill.TxnDate}T00:00:00Z`).toISOString(),
              kind: "received" as const,
            })),
        ),
      );
    },
  };
}

function pickDefined(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((k) => source[k] !== undefined).map((k) => [k, source[k]]));
}
