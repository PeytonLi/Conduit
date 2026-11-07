import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  AppliedDelivery,
  ChangeLookup,
  DeliverySplitResult,
  ErpClient,
  ErpDemand,
  ErpItem,
  ErpPurchaseOrder,
  ErpReceipt,
  ErpSnapshot,
  ErpStockLevel,
} from "../types";
import { OdooRpcError, OdooTransportError, type OdooTransport } from "./transport";

const m2o = z.union([z.tuple([z.number().int(), z.union([z.string(), z.literal(false)])]), z.literal(false)]);
const text = z.union([z.string(), z.literal(false)]);
const ids = z.array(z.number().int());

const poSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  partner_id: m2o,
  currency_id: m2o,
  state: z.string(),
  locked: z.boolean().optional(),
  partner_ref: text,
  picking_type_id: m2o,
  write_date: z.string(),
  order_line: ids,
});
type PoRow = z.infer<typeof poSchema>;

const lineSchema = z
  .object({
    id: z.number().int(),
    order_id: m2o,
    product_id: m2o,
    product_qty: z.number(),
    product_uom_qty: z.number(),
    qty_received: z.number(),
    price_unit: z.number(),
    date_planned: text,
    display_type: text,
    write_date: z.string(),
  })
  .passthrough();
type LineRow = z.infer<typeof lineSchema>;

const PO_FIELDS = ["name", "partner_id", "currency_id", "state", "locked", "partner_ref", "picking_type_id", "write_date", "order_line"];
const LINE_FIELDS = ["order_id", "product_id", "product_qty", "product_uom_qty", "qty_received", "price_unit", "date_planned", "display_type", "write_date"];
const OPEN_PO_STATES = ["purchase"];
const CHANGE_TAG = "conduit-split";

export class OdooDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OdooDataError";
  }
}

const idOf = (value: z.infer<typeof m2o>): number | null => (value === false ? null : value[0]);

/** Odoo stores naive UTC "YYYY-MM-DD HH:MM:SS". */
export function fromOdooDate(value: string | false): string | null {
  if (!value) return null;
  return new Date(`${value.replace(" ", "T")}Z`).toISOString();
}

export function toOdooDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 19).replace("T", " ");
}

function wholeQty(value: number, what: string): number {
  const rounded = Math.round(value);
  if (Math.abs(value - rounded) > 1e-6) throw new OdooDataError(`${what} is not a whole quantity (${value})`);
  return rounded;
}

/**
 * Odoo has no compare-and-set over RPC and write_date only has second precision, so the version is
 * the newest write_date plus a hash of every field a split depends on. A change in the same second
 * still moves the hash; a change landing between our read and our write is not caught.
 */
export function poVersion(po: PoRow, lines: LineRow[]): string {
  const sorted = [...lines].sort((a, b) => a.id - b.id);
  const newest = [po.write_date, ...sorted.map((l) => l.write_date)].sort().at(-1)!;
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        po.state,
        po.locked ?? null,
        po.partner_ref,
        idOf(po.partner_id),
        idOf(po.currency_id),
        sorted.map((l) => [l.id, idOf(l.product_id), l.product_qty, l.qty_received, l.price_unit, l.date_planned]),
      ]),
    )
    .digest("hex")
    .slice(0, 16);
  return `${newest.replace(" ", "T")}Z~${digest}`;
}

const splitRequestSchema = z.object({
  change_ref: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
  po_external_id: z.string().regex(/^\d+$/),
  line_external_id: z.string().regex(/^\d+$/),
  expected_version: z.string().min(1),
  schedules: z
    .array(
      z.object({
        quantity: z.number().int().positive(),
        earliest_at: z.string().datetime({ offset: true }),
        latest_at: z.string().datetime({ offset: true }),
      }),
    )
    .min(1)
    .max(20),
});

interface PlannedDelivery {
  quantity: number;
  due_at: string;
}

export function changeStamp(ref: string, lineId: number, plan: PlannedDelivery[]): string {
  const human = plan.map((d) => `${d.quantity} due ${d.due_at.slice(0, 16).replace("T", " ")} UTC`).join(", ");
  const machine = plan.map((d) => `${d.quantity}@${d.due_at}`).join(",");
  return `Conduit split PO line ${lineId} into ${human}. [${CHANGE_TAG} ref=${ref} line=${lineId} plan=${machine}]`;
}

export function parseChangeStamp(body: string, ref: string): { lineId: number; plan: PlannedDelivery[] } | null {
  const plain = body.replace(/<[^>]*>/g, " ");
  const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = plain.match(new RegExp(`\\[${CHANGE_TAG} ref=${escaped} line=(\\d+) plan=([^\\]\\s]+)\\]`));
  if (!match) return null;
  const plan: PlannedDelivery[] = [];
  for (const part of match[2].split(",")) {
    const [qty, due] = part.split("@");
    const quantity = Number(qty);
    if (!Number.isInteger(quantity) || Number.isNaN(Date.parse(due ?? ""))) return null;
    plan.push({ quantity, due_at: new Date(due).toISOString() });
  }
  return { lineId: Number(match[1]), plan };
}

export function createOdooErpClient(transport: OdooTransport, deps: { now?: () => Date } = {}): ErpClient {
  const now = deps.now ?? (() => new Date());
  const searchRead = <T extends z.ZodType>(model: string, domain: unknown[], fields: string[], schema: T, extra: Record<string, unknown> = {}) =>
    transport.call(model, "search_read", { domain, fields, ...extra }, z.array(schema));

  const currencyDigits = async (currencyIds: number[]) => {
    if (currencyIds.length === 0) return new Map<number, { name: string; digits: number }>();
    const rows = await searchRead("res.currency", [["id", "in", currencyIds]], ["name", "decimal_places"], z.object({ id: z.number().int(), name: z.string(), decimal_places: z.number().int() }), { context: { active_test: false } });
    return new Map(rows.map((r) => [r.id, { name: r.name, digits: r.decimal_places }]));
  };

  const pickingWarehouses = async (typeIds: number[]) => {
    if (typeIds.length === 0) return new Map<number, number | null>();
    const rows = await searchRead("stock.picking.type", [["id", "in", typeIds]], ["warehouse_id"], z.object({ id: z.number().int(), warehouse_id: m2o }), { context: { active_test: false } });
    return new Map(rows.map((r) => [r.id, idOf(r.warehouse_id)]));
  };

  const loadOrders = async (domain: unknown[], limit?: number) => {
    const pos = await searchRead("purchase.order", domain, PO_FIELDS, poSchema, limit ? { limit, order: "id desc" } : {});
    const lineIds = pos.flatMap((p) => p.order_line);
    const lines = lineIds.length
      ? await searchRead("purchase.order.line", [["id", "in", lineIds]], LINE_FIELDS, lineSchema, { order: "id asc" })
      : [];
    const [currencies, warehouses] = await Promise.all([
      currencyDigits([...new Set(pos.map((p) => idOf(p.currency_id)).filter((v): v is number => v !== null))]),
      pickingWarehouses([...new Set(pos.map((p) => idOf(p.picking_type_id)).filter((v): v is number => v !== null))]),
    ]);
    return pos.map((po) => {
      const own = lines.filter((l) => idOf(l.order_id) === po.id);
      return { raw: po, rawLines: own, mapped: mapOrder(po, own, currencies, warehouses) };
    });
  };

  const mapOrder = (
    po: PoRow,
    lines: LineRow[],
    currencies: Map<number, { name: string; digits: number }>,
    warehouses: Map<number, number | null>,
  ): ErpPurchaseOrder => {
    const currency = currencies.get(idOf(po.currency_id) ?? -1);
    if (!currency) throw new OdooDataError(`Purchase order ${po.name} has no readable currency`);
    const warehouse = warehouses.get(idOf(po.picking_type_id) ?? -1) ?? null;
    return {
      external_id: String(po.id),
      supplier_external_id: String(idOf(po.partner_id) ?? ""),
      currency: currency.name,
      status: po.locked ? `${po.state}_locked` : po.state,
      version: poVersion(po, lines),
      lines: lines
        .filter((l) => !l.display_type && idOf(l.product_id) !== null)
        .map((l) => {
          // Report in the product's unit: product_uom_qty is product_qty converted by Odoo.
          const ratio = l.product_qty === 0 ? 1 : l.product_uom_qty / l.product_qty;
          return {
            external_line_id: String(l.id),
            item_external_id: String(idOf(l.product_id)),
            ordered_qty: wholeQty(l.product_uom_qty, `PO ${po.name} line ${l.id} quantity`),
            received_qty: wholeQty(l.qty_received * ratio, `PO ${po.name} line ${l.id} received`),
            unit_price_minor: String(Math.round((l.price_unit / ratio) * 10 ** currency.digits)),
            due_at: fromOdooDate(l.date_planned),
            destination_external_id: warehouse === null ? "" : String(warehouse),
          };
        }),
    };
  };

  const readOne = async (poExternalId: string) => {
    if (!/^\d+$/.test(poExternalId)) return null;
    const [found] = await loadOrders([["id", "=", Number(poExternalId)]]);
    return found ?? null;
  };

  const findChange = async (changeRef: string, poExternalId: string): Promise<ChangeLookup> => {
    if (!/^\d+$/.test(poExternalId)) return { status: "not_found" };
    const messages = await searchRead(
      "mail.message",
      [["model", "=", "purchase.order"], ["res_id", "=", Number(poExternalId)], ["body", "ilike", `${CHANGE_TAG} ref=${changeRef} `]],
      ["body"],
      z.object({ id: z.number().int(), body: text }),
      { order: "id asc", limit: 5 },
    );
    for (const message of messages) {
      const stamp = message.body ? parseChangeStamp(message.body, changeRef) : null;
      if (!stamp) continue;
      const po = await readOne(poExternalId);
      return {
        status: "applied",
        provider_ref: `odoo:purchase.order/${poExternalId}#mail.message/${message.id}`,
        deliveries: matchDeliveries(stamp.lineId, stamp.plan, po?.rawLines ?? []),
      };
    }
    return { status: "not_found" };
  };

  /** First delivery stays on the original line; later ones are the newer lines with the same product, qty and date. */
  const matchDeliveries = (lineId: number, plan: PlannedDelivery[], lines: LineRow[]): AppliedDelivery[] => {
    const original = lines.find((l) => l.id === lineId);
    const used = new Set<number>([lineId]);
    return plan.map((d, i) => {
      if (i === 0) return { external_ref: String(lineId), quantity: d.quantity, due_at: d.due_at };
      const match = lines.find(
        (l) =>
          !used.has(l.id) &&
          l.id > lineId &&
          idOf(l.product_id) === (original ? idOf(original.product_id) : idOf(l.product_id)) &&
          Math.round(l.product_qty) === d.quantity &&
          fromOdooDate(l.date_planned) === d.due_at,
      );
      if (match) used.add(match.id);
      return { external_ref: match ? String(match.id) : `unmatched:${lineId}:${i}`, quantity: d.quantity, due_at: d.due_at };
    });
  };

  return {
    provider: "odoo",

    async readSnapshot(): Promise<ErpSnapshot> {
      const asOf = now().toISOString();
      const orders = await loadOrders([["state", "in", OPEN_PO_STATES]], 200);
      const demandMoves = await searchRead(
        "stock.move",
        [
          ["state", "not in", ["draft", "done", "cancel"]],
          ["location_id.usage", "=", "internal"],
          ["location_dest_id.usage", "in", ["customer", "production"]],
        ],
        ["product_id", "product_qty", "date", "location_id"],
        z.object({ id: z.number().int(), product_id: m2o, product_qty: z.number(), date: z.string(), location_id: m2o }),
        { limit: 2000, order: "date asc" },
      );
      const productIds = [
        ...new Set([
          ...orders.flatMap((o) => o.mapped.lines.map((l) => Number(l.item_external_id))),
          ...demandMoves.map((m) => idOf(m.product_id)).filter((v): v is number => v !== null),
        ]),
      ];
      const [warehouses, products, quants, partners] = await Promise.all([
        searchRead("stock.warehouse", [], ["name"], z.object({ id: z.number().int(), name: z.string() })),
        productIds.length
          ? searchRead("product.product", [["id", "in", productIds]], ["default_code", "name", "uom_id"], z.object({ id: z.number().int(), default_code: text, name: z.string(), uom_id: m2o }), { context: { active_test: false } })
          : Promise.resolve([]),
        productIds.length
          ? searchRead("stock.quant", [["product_id", "in", productIds], ["location_id.usage", "=", "internal"]], ["product_id", "warehouse_id", "quantity"], z.object({ id: z.number().int(), product_id: m2o, warehouse_id: m2o, quantity: z.number() }))
          : Promise.resolve([]),
        (async () => {
          const partnerIds = [...new Set(orders.map((o) => idOf(o.raw.partner_id)).filter((v): v is number => v !== null))];
          return partnerIds.length
            ? searchRead("res.partner", [["id", "in", partnerIds]], ["name", "email", "phone"], z.object({ id: z.number().int(), name: z.string(), email: text, phone: text }), { context: { active_test: false } })
            : [];
        })(),
      ]);
      const locationIds = [...new Set(demandMoves.map((m) => idOf(m.location_id)).filter((v): v is number => v !== null))];
      const locations = locationIds.length
        ? await searchRead("stock.location", [["id", "in", locationIds]], ["warehouse_id"], z.object({ id: z.number().int(), warehouse_id: m2o }), { context: { active_test: false } })
        : [];
      const locationWarehouse = new Map(locations.map((l) => [l.id, idOf(l.warehouse_id)]));

      const stockByKey = new Map<string, number>();
      for (const q of quants) {
        const wh = idOf(q.warehouse_id);
        const product = idOf(q.product_id);
        if (wh === null || product === null) continue;
        const key = `${product}|${wh}`;
        stockByKey.set(key, (stockByKey.get(key) ?? 0) + q.quantity);
      }
      const stock: ErpStockLevel[] = [...stockByKey].map(([key, qty]) => {
        const [product, wh] = key.split("|");
        return { item_external_id: product, location_external_id: wh, on_hand_qty: wholeQty(qty, `On-hand for product ${product}`) };
      });
      const demand: ErpDemand[] = demandMoves.flatMap((m) => {
        const wh = locationWarehouse.get(idOf(m.location_id) ?? -1);
        const product = idOf(m.product_id);
        if (wh == null || product === null) return [];
        return [{
          external_id: `stock.move/${m.id}`,
          item_external_id: String(product),
          location_external_id: String(wh),
          quantity: wholeQty(m.product_qty, `Demand move ${m.id}`),
          required_at: fromOdooDate(m.date)!,
          certainty: "confirmed" as const,
        }];
      });
      const items: ErpItem[] = products.map((p) => ({
        external_id: String(p.id),
        sku: p.default_code || `odoo-${p.id}`,
        name: p.name,
        unit: p.uom_id === false || p.uom_id[1] === false ? "unit" : p.uom_id[1],
      }));
      return {
        as_of: asOf,
        locations: warehouses.map((w) => ({ external_id: String(w.id), name: w.name })),
        items,
        suppliers: partners.map((p) => ({ external_id: String(p.id), name: p.name, email: p.email || null, phone: p.phone || null })),
        purchase_orders: orders.map((o) => o.mapped),
        stock,
        demand,
      };
    },

    async readPurchaseOrder(poExternalId) {
      return (await readOne(poExternalId))?.mapped ?? null;
    },

    async applyDeliverySplit(input): Promise<DeliverySplitResult> {
      const parsed = splitRequestSchema.safeParse(input);
      if (!parsed.success) return { status: "rejected", code: "invalid_request", message: "Split request is invalid" };
      const req = parsed.data;
      try {
        const existing = await findChange(req.change_ref, req.po_external_id);
        if (existing.status === "applied") {
          const current = await readOne(req.po_external_id);
          return { status: "applied", provider_ref: existing.provider_ref, version: current?.mapped.version ?? req.expected_version, deliveries: existing.deliveries };
        }
        const current = await readOne(req.po_external_id);
        if (!current) return { status: "rejected", code: "not_found", message: "Purchase order not found" };
        if (current.mapped.version !== req.expected_version) {
          return { status: "conflict", current_version: current.mapped.version, message: "Purchase order changed in Odoo since it was read" };
        }
        if (current.raw.state !== "purchase" || current.raw.locked) {
          return { status: "rejected", code: "not_editable", message: `Purchase order is ${current.raw.locked ? "locked" : current.raw.state}` };
        }
        const lineId = Number(req.line_external_id);
        const line = current.rawLines.find((l) => l.id === lineId);
        const mappedLine = current.mapped.lines.find((l) => l.external_line_id === req.line_external_id);
        if (!line || !mappedLine) return { status: "rejected", code: "not_found", message: "Line not found" };
        if (line.product_qty !== line.product_uom_qty) {
          return { status: "rejected", code: "unit_mismatch", message: "Line is ordered in a different unit than the product" };
        }
        const open = mappedLine.ordered_qty - mappedLine.received_qty;
        if (req.schedules.reduce((s, d) => s + d.quantity, 0) !== open) {
          return { status: "rejected", code: "quantity_mismatch", message: "Schedules must cover the open quantity" };
        }

        const plan = req.schedules.map((s) => ({ quantity: s.quantity, due_at: new Date(s.earliest_at).toISOString() }));
        // Lowering product_qty on a confirmed line makes Odoo 20 create a return to the vendor
        // instead of shrinking the receipt, so shrink the open receipt moves in the same write.
        const openMoves = await searchRead(
          "stock.move",
          [["purchase_line_id", "=", lineId], ["state", "not in", ["done", "cancel"]], ["location_dest_id.usage", "!=", "supplier"]],
          ["product_uom_qty"],
          z.object({ id: z.number().int(), product_uom_qty: z.number() }),
          { order: "date desc, id desc" },
        );
        let excess = openMoves.reduce((sum, m) => sum + m.product_uom_qty, 0) - plan[0].quantity;
        const moveCommands: unknown[] = [];
        for (const move of openMoves) {
          if (excess <= 0) break;
          const cut = Math.min(excess, move.product_uom_qty);
          moveCommands.push([1, move.id, { product_uom_qty: move.product_uom_qty - cut }]);
          excess -= cut;
        }
        const commands: unknown[] = [[1, lineId, {
          product_qty: mappedLine.received_qty + plan[0].quantity,
          date_planned: toOdooDate(plan[0].due_at),
          ...(moveCommands.length ? { move_ids: moveCommands } : {}),
        }]];
        if (plan.length > 1) {
          const [template] = await transport.call("purchase.order.line", "copy_data", { ids: [lineId] }, z.array(z.record(z.string(), z.unknown())).length(1));
          const base = { ...template };
          delete base.order_id;
          for (const d of plan.slice(1)) {
            const date = toOdooDate(d.due_at);
            commands.push([0, 0, { ...base, product_qty: d.quantity, date_planned: date, ...("date_promised" in base ? { date_promised: date } : {}) }]);
          }
        }
        // The stamp is created in the same write (same transaction) as the line changes, so
        // findChange sees it if and only if the split committed.
        const subtype = await transport.call("ir.model.data", "check_object_reference", { module: "mail", xml_id: "mt_note" }, z.tuple([z.string(), z.number().int()]));
        await transport.call(
          "purchase.order",
          "write",
          {
            ids: [current.raw.id],
            vals: {
              order_line: commands,
              message_ids: [[0, 0, {
                model: "purchase.order",
                body: changeStamp(req.change_ref, lineId, plan),
                message_type: "comment",
                subtype_id: subtype[1],
              }]],
            },
          },
          z.literal(true),
        );
        const after = await readOne(req.po_external_id);
        const found = await findChange(req.change_ref, req.po_external_id);
        if (!after || found.status !== "applied") {
          return { status: "unknown", message: "Odoo accepted the write but the change could not be read back" };
        }
        return { status: "applied", provider_ref: found.provider_ref, version: after.mapped.version, deliveries: found.deliveries };
      } catch (error) {
        if (error instanceof OdooRpcError) {
          return { status: "rejected", code: `odoo_${error.odooName.split(".").at(-1)?.toLowerCase() ?? "error"}`, message: error.message.slice(0, 300) };
        }
        if (error instanceof OdooTransportError) return { status: "unknown", message: error.message };
        throw error;
      }
    },

    findChange,

    async listReceipts(since): Promise<ErpReceipt[]> {
      const moveSchema = z.object({
        id: z.number().int(),
        purchase_line_id: m2o,
        quantity: z.number(),
        date: z.string(),
        origin_returned_move_id: m2o,
      });
      const base: unknown[] = [["purchase_line_id", "!=", false], ["state", "=", "done"]];
      if (since) base.push(["date", ">=", toOdooDate(since)]);
      const fields = ["purchase_line_id", "quantity", "date", "origin_returned_move_id"];
      const [inbound, returns] = await Promise.all([
        searchRead("stock.move", [...base, ["location_dest_id.usage", "!=", "supplier"]], fields, moveSchema, { order: "date asc, id asc", limit: 1000 }),
        searchRead("stock.move", [...base, ["location_dest_id.usage", "=", "supplier"]], fields, moveSchema, { order: "date asc, id asc", limit: 1000 }),
      ]);
      const lineIds = [...new Set([...inbound, ...returns].map((m) => idOf(m.purchase_line_id)).filter((v): v is number => v !== null))];
      const lines = lineIds.length
        ? await searchRead("purchase.order.line", [["id", "in", lineIds]], ["order_id"], z.object({ id: z.number().int(), order_id: m2o }))
        : [];
      const orderOf = new Map(lines.map((l) => [l.id, idOf(l.order_id)]));
      const map = (m: z.infer<typeof moveSchema>, kind: ErpReceipt["kind"]): ErpReceipt => {
        const lineId = idOf(m.purchase_line_id)!;
        const origin = idOf(m.origin_returned_move_id);
        return {
          external_receipt_id: `stock.move/${m.id}`,
          po_external_id: String(orderOf.get(lineId) ?? ""),
          line_external_id: String(lineId),
          quantity: wholeQty(m.quantity, `Receipt move ${m.id}`),
          received_at: fromOdooDate(m.date)!,
          kind,
          ...(kind === "reversal" && origin !== null ? { reverses_external_id: `stock.move/${origin}` } : {}),
        };
      };
      return [...inbound.map((m) => map(m, "received")), ...returns.map((m) => map(m, "reversal"))].sort((a, b) =>
        a.received_at.localeCompare(b.received_at),
      );
    },
  };
}
