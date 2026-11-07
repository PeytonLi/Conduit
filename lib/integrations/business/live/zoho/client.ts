import { createHash } from "node:crypto";
import { z } from "zod";
import { currencyMinorDigits, parseMajorDecimal, toMinorString } from "@/lib/domain/money";
import type {
  AppliedDelivery,
  ChangeLookup,
  DeliverySplitRequest,
  DeliverySplitResult,
  ErpClient,
  ErpDemand,
  ErpItem,
  ErpLocation,
  ErpPurchaseOrder,
  ErpReceipt,
  ErpSnapshot,
  ErpStockLevel,
  ErpSupplier,
} from "../types";
import { ZohoApiError, ZohoDataError, ZohoRateLimitError, ZohoTransportError } from "./errors";
import { createZohoHttp, type ZohoHttp, type ZohoHttpConfig } from "./http";
import {
  zohoEnvelopeSchema,
  zohoItemResponseSchema,
  zohoLocationsResponseSchema,
  zohoPurchaseOrderListSchema,
  zohoPurchaseOrderResponseSchema,
  zohoReceiveListSchema,
  zohoReceiveResponseSchema,
  zohoSalesOrderListSchema,
  zohoSalesOrderResponseSchema,
  type ZohoPurchaseOrder,
  type ZohoPurchaseOrderLine,
} from "./schemas";

export interface ZohoClientLimits {
  /** Each list call reads at most this many pages of 200 records. */
  maxPages: number;
  /** Open POs / sales orders / items fetched in detail per snapshot; more is an error, never a silent cut. */
  maxDetailReads: number;
}

export const DEFAULT_ZOHO_LIMITS: ZohoClientLimits = { maxPages: 10, maxDetailReads: 150 };

const PER_PAGE = 200;
const CLOSED_PO_STATUSES = new Set(["draft", "cancelled", "closed", "received", "pending_approval", "rejected", "void"]);
const CLOSED_SO_STATUSES = new Set(["draft", "void", "closed", "fulfilled", "shipped", "delivered", "cancelled"]);
const CHANGE_REF = /^[A-Za-z0-9._:-]{1,80}$/;
const MARKER_PREFIX = "Conduit change ";

const markerSchema = z.object({
  line: z.string().min(1),
  deliveries: z.array(z.object({
    ref: z.string().min(1),
    qty: z.number().int().positive(),
    due: z.string().nullable(),
  })).min(1),
});
type Marker = z.infer<typeof markerSchema>;

export function createZohoInventoryClient(
  config: ZohoHttpConfig & { limits?: Partial<ZohoClientLimits> },
): ErpClient {
  const http = createZohoHttp(config);
  const limits = { ...DEFAULT_ZOHO_LIMITS, ...config.limits };
  const orgLocationId = `org:${config.credentials.organization_id}`;
  return {
    provider: "zoho_inventory",
    readSnapshot: () => readSnapshot(http, limits, orgLocationId, config.now),
    async readPurchaseOrder(poExternalId) {
      const po = await getPurchaseOrder(http, poExternalId);
      return po ? mapPurchaseOrder(po, orgLocationId) : null;
    },
    applyDeliverySplit: (request) => applyDeliverySplit(http, limits, request, config.now),
    async findChange(changeRef, poExternalId) {
      const po = await getPurchaseOrder(http, poExternalId);
      return po ? lookupMarker(po, changeRef) : { status: "not_found" };
    },
    listReceipts: (since) => listReceipts(http, limits, since),
  };
}

function intQty(value: number, field: string): number {
  if (!Number.isInteger(value)) {
    throw new ZohoDataError(`Zoho ${field} ${value} is fractional; Conduit needs whole units`);
  }
  return value;
}

function dateToIso(date: string | null): string | null {
  return date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00.000Z` : null;
}

function isoToDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

function zohoTimeMs(value: string | undefined): number | null {
  if (!value) return null;
  const normalized = value.replace(" ", "T").replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}

function lineRate(line: ZohoPurchaseOrderLine): number {
  return line.purchase_rate ?? line.rate ?? 0;
}

function lineOpenQty(line: ZohoPurchaseOrderLine): number {
  return line.quantity - line.quantity_cancelled - line.quantity_received;
}

function poDueDate(po: ZohoPurchaseOrder): string | null {
  return po.delivery_date ?? po.expected_delivery_date;
}

function mapPurchaseOrder(po: ZohoPurchaseOrder, orgLocationId: string): ErpPurchaseOrder {
  if (!po.currency_code) throw new ZohoDataError(`Zoho PO ${po.purchaseorder_id} has no currency_code`);
  const currency = po.currency_code;
  const digits = currencyMinorDigits(currency);
  return {
    external_id: po.purchaseorder_id,
    supplier_external_id: po.vendor_id,
    currency,
    status: po.status,
    version: po.last_modified_time,
    lines: po.line_items.map((line) => ({
      external_line_id: line.line_item_id,
      item_external_id: line.item_id,
      ordered_qty: intQty(line.quantity - line.quantity_cancelled, "quantity"),
      received_qty: intQty(line.quantity_received, "quantity_received"),
      unit_price_minor: toMinorString(parseMajorDecimal(lineRate(line).toFixed(digits), currency)),
      due_at: dateToIso(poDueDate(po)),
      destination_external_id: line.location_id ?? line.warehouse_id ?? po.location_id ?? orgLocationId,
    })),
  };
}

function isNotFound(error: unknown): boolean {
  return error instanceof ZohoApiError && (error.httpStatus === 404 || error.zohoCode === 1002);
}

async function getPurchaseOrder(http: ZohoHttp, id: string): Promise<ZohoPurchaseOrder | null> {
  if (!/^\d+$/.test(id)) return null;
  try {
    return (await http.get(`/purchaseorders/${id}`, zohoPurchaseOrderResponseSchema)).purchaseorder;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function listAll<T>(
  http: ZohoHttp,
  limits: ZohoClientLimits,
  path: string,
  schema: z.ZodType<{ page_context?: { has_more_page: boolean } } & Record<string, unknown>>,
  key: string,
  query: Record<string, string | number | undefined> = {},
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= limits.maxPages; page += 1) {
    const data = await http.get(path, schema, { ...query, page, per_page: PER_PAGE });
    out.push(...(data[key] as T[]));
    if (!data.page_context?.has_more_page) return out;
  }
  throw new ZohoDataError(`Zoho ${path} has more than ${limits.maxPages * PER_PAGE} records`);
}

function capDetails<T>(records: T[], limits: ZohoClientLimits, what: string): T[] {
  if (records.length > limits.maxDetailReads) {
    throw new ZohoDataError(`${records.length} open ${what} exceed the ${limits.maxDetailReads} read limit`);
  }
  return records;
}

async function readSnapshot(
  http: ZohoHttp,
  limits: ZohoClientLimits,
  orgLocationId: string,
  now: () => Date,
): Promise<ErpSnapshot> {
  const as_of = now().toISOString();
  const locations = new Map<string, ErpLocation>();
  try {
    const data = await http.get("/locations", zohoLocationsResponseSchema);
    for (const location of data.locations) {
      if (location.status !== "inactive") {
        locations.set(location.location_id, { external_id: location.location_id, name: location.location_name });
      }
    }
  } catch (error) {
    if (!(error instanceof ZohoApiError) || error instanceof ZohoRateLimitError) throw error;
  }

  const poSummaries = await listAll<z.infer<typeof zohoPurchaseOrderListSchema>["purchaseorders"][number]>(
    http, limits, "/purchaseorders", zohoPurchaseOrderListSchema, "purchaseorders",
  );
  const purchaseOrders: ErpPurchaseOrder[] = [];
  const suppliers = new Map<string, ErpSupplier>();
  const itemIds = new Set<string>();
  const openPos = capDetails(
    poSummaries.filter((po) => !CLOSED_PO_STATUSES.has(po.status.toLowerCase())),
    limits,
    "purchase orders",
  );
  for (const summary of openPos) {
    const po = await getPurchaseOrder(http, summary.purchaseorder_id);
    if (!po || !po.line_items.some((line) => lineOpenQty(line) > 0)) continue;
    purchaseOrders.push(mapPurchaseOrder(po, orgLocationId));
    suppliers.set(po.vendor_id, { external_id: po.vendor_id, name: po.vendor_name, email: null, phone: null });
    for (const line of po.line_items) itemIds.add(line.item_id);
  }

  const soSummaries = await listAll<z.infer<typeof zohoSalesOrderListSchema>["salesorders"][number]>(
    http, limits, "/salesorders", zohoSalesOrderListSchema, "salesorders",
  );
  const demand: ErpDemand[] = [];
  const openSos = capDetails(
    soSummaries.filter((so) => !CLOSED_SO_STATUSES.has(so.status.toLowerCase())),
    limits,
    "sales orders",
  );
  for (const summary of openSos) {
    const { salesorder: so } = await http.get(`/salesorders/${summary.salesorder_id}`, zohoSalesOrderResponseSchema);
    const requiredAt = dateToIso(so.shipment_date ?? so.date);
    if (!requiredAt) continue;
    for (const line of so.line_items) {
      const open = line.quantity - line.quantity_cancelled - line.quantity_shipped;
      if (open <= 0) continue;
      itemIds.add(line.item_id);
      demand.push({
        external_id: `${so.salesorder_id}:${line.line_item_id}`,
        item_external_id: line.item_id,
        location_external_id: line.location_id ?? line.warehouse_id ?? so.location_id ?? orgLocationId,
        quantity: intQty(open, "sales order quantity"),
        required_at: requiredAt,
        certainty: "confirmed",
      });
    }
  }

  const items: ErpItem[] = [];
  const stock: ErpStockLevel[] = [];
  for (const itemId of capDetails([...itemIds], limits, "items")) {
    const { item } = await http.get(`/items/${itemId}`, zohoItemResponseSchema);
    items.push({ external_id: item.item_id, sku: item.sku || item.item_id, name: item.name, unit: item.unit || "unit" });
    for (const location of item.locations) {
      if (!locations.has(location.location_id)) {
        locations.set(location.location_id, { external_id: location.location_id, name: location.location_name });
      }
      stock.push({
        item_external_id: item.item_id,
        location_external_id: location.location_id,
        on_hand_qty: intQty(Math.max(location.location_stock_on_hand, 0), "stock on hand"),
      });
    }
  }

  const referenced = [
    ...purchaseOrders.flatMap((po) => po.lines.map((line) => line.destination_external_id)),
    ...demand.map((row) => row.location_external_id),
  ];
  if (referenced.includes(orgLocationId)) {
    locations.set(orgLocationId, { external_id: orgLocationId, name: "Organization" });
  }

  return {
    as_of,
    locations: [...locations.values()],
    items,
    suppliers: [...suppliers.values()],
    purchase_orders: purchaseOrders,
    stock,
    demand,
  };
}

function parseMarker(notes: string, changeRef: string): Marker | null {
  const prefix = `${MARKER_PREFIX}${changeRef}: `;
  for (const line of notes.split(/\r?\n/)) {
    if (!line.startsWith(prefix)) continue;
    try {
      const parsed = markerSchema.safeParse(JSON.parse(line.slice(prefix.length)));
      if (parsed.success) return parsed.data;
    } catch {
      continue;
    }
  }
  return null;
}

function lookupMarker(po: ZohoPurchaseOrder, changeRef: string): ChangeLookup {
  const marker = parseMarker(po.notes, changeRef);
  if (!marker) return { status: "not_found" };
  return {
    status: "applied",
    provider_ref: po.purchaseorder_id,
    deliveries: marker.deliveries.map(toApplied),
  };
}

function toApplied(delivery: Marker["deliveries"][number]): AppliedDelivery {
  return { external_ref: delivery.ref, quantity: delivery.qty, due_at: dateToIso(delivery.due) };
}

export function zohoFollowUpReference(changeRef: string, index: number): string {
  return `CDT-${createHash("sha256").update(changeRef).digest("hex").slice(0, 16)}-${index}`;
}

function writeLine(line: ZohoPurchaseOrderLine, quantity: number): Record<string, unknown> {
  return {
    line_item_id: line.line_item_id,
    item_id: line.item_id,
    quantity,
    purchase_rate: lineRate(line),
    ...(line.unit ? { unit: line.unit } : {}),
    ...(line.account_id ? { account_id: line.account_id } : {}),
    ...(line.tax_id ? { tax_id: line.tax_id } : {}),
    ...(line.location_id ? { location_id: line.location_id } : {}),
  };
}

async function findFollowUps(
  http: ZohoHttp,
  limits: ZohoClientLimits,
  changeRef: string,
  count: number,
): Promise<Map<number, ZohoPurchaseOrder>> {
  const wanted = new Map<string, number>();
  for (let index = 1; index <= count; index += 1) wanted.set(zohoFollowUpReference(changeRef, index), index);
  const found = new Map<number, ZohoPurchaseOrder>();
  for (const [reference, index] of wanted) {
    const matches = (await listAll<z.infer<typeof zohoPurchaseOrderListSchema>["purchaseorders"][number]>(
      http, limits, "/purchaseorders", zohoPurchaseOrderListSchema, "purchaseorders",
      { reference_number: reference, sort_column: "created_time", sort_order: "D" },
    )).filter((po) => po.reference_number === reference && po.status.toLowerCase() !== "cancelled");
    if (matches.length > 1) throw new ZohoDataError(`Several Zoho POs carry reference ${reference}`);
    if (matches.length === 1) {
      const po = await getPurchaseOrder(http, matches[0].purchaseorder_id);
      if (po) found.set(index, po);
    }
  }
  return found;
}

async function applyDeliverySplit(
  http: ZohoHttp,
  limits: ZohoClientLimits,
  request: DeliverySplitRequest,
  now: () => Date,
): Promise<DeliverySplitResult> {
  if (!CHANGE_REF.test(request.change_ref)) {
    return { status: "rejected", code: "invalid_change_ref", message: "change_ref has unsupported characters" };
  }
  if (
    request.schedules.length === 0 ||
    request.schedules.some((s) => !Number.isInteger(s.quantity) || s.quantity <= 0 || Number.isNaN(Date.parse(s.latest_at)))
  ) {
    return { status: "rejected", code: "invalid_schedule", message: "Schedules need positive whole quantities and dates" };
  }

  let po: ZohoPurchaseOrder | null;
  try {
    po = await getPurchaseOrder(http, request.po_external_id);
  } catch (error) {
    return failure(error);
  }
  if (!po) return { status: "rejected", code: "po_not_found", message: "Purchase order not found in Zoho" };

  const existing = lookupMarker(po, request.change_ref);
  if (existing.status === "applied") {
    return { status: "applied", provider_ref: existing.provider_ref, version: po.last_modified_time, deliveries: existing.deliveries };
  }
  if (po.last_modified_time !== request.expected_version) {
    return { status: "conflict", current_version: po.last_modified_time, message: "Purchase order changed in Zoho since it was read" };
  }
  if (CLOSED_PO_STATUSES.has(po.status.toLowerCase()) && po.status.toLowerCase() !== "draft") {
    return { status: "rejected", code: "po_not_open", message: `Purchase order is ${po.status}` };
  }
  const line = po.line_items.find((candidate) => candidate.line_item_id === request.line_external_id);
  if (!line) return { status: "rejected", code: "line_not_found", message: "Line not found on the purchase order" };
  const open = lineOpenQty(line);
  const total = request.schedules.reduce((sum, s) => sum + s.quantity, 0);
  if (total !== open) {
    return { status: "rejected", code: "quantity_mismatch", message: `Schedules total ${total}, open quantity is ${open}` };
  }
  if (po.line_items.some((other) => other !== line && lineOpenQty(other) > 0)) {
    return {
      status: "rejected",
      code: "not_supported_by_provider",
      message: "Zoho POs have one delivery date per PO; split POs with other open lines manually",
    };
  }

  const [first, ...later] = request.schedules;
  const deliveries: Marker["deliveries"] = [
    { ref: line.line_item_id, qty: first.quantity, due: isoToDate(first.latest_at) },
  ];
  const created: string[] = [];
  try {
    const followUps = await findFollowUps(http, limits, request.change_ref, later.length);
    for (const [offset, schedule] of later.entries()) {
      const index = offset + 1;
      let followUp = followUps.get(index) ?? null;
      if (!followUp) {
        followUp = (await http.send("POST", "/purchaseorders", zohoPurchaseOrderResponseSchema, {
          query: { ignore_auto_number_generation: "false" },
          body: {
            vendor_id: po.vendor_id,
            date: now().toISOString().slice(0, 10),
            delivery_date: isoToDate(schedule.latest_at),
            reference_number: zohoFollowUpReference(request.change_ref, index),
            notes: `${MARKER_PREFIX}${request.change_ref}: later delivery split from ${po.purchaseorder_number || po.purchaseorder_id}`,
            ...(po.location_id ? { location_id: po.location_id } : {}),
            line_items: [{ ...writeLine(line, schedule.quantity), line_item_id: undefined }],
          },
        })).purchaseorder;
        created.push(followUp.purchaseorder_id);
        if (po.status.toLowerCase() !== "draft") {
          await http.send("POST", `/purchaseorders/${followUp.purchaseorder_id}/status/issued`, zohoEnvelopeSchema);
        }
      }
      const followLine = followUp.line_items[0];
      if (!followLine) throw new ZohoDataError("Zoho returned a follow-up PO without lines");
      deliveries.push({
        ref: `${followUp.purchaseorder_id}:${followLine.line_item_id}`,
        qty: schedule.quantity,
        due: poDueDate(followUp) ?? isoToDate(schedule.latest_at),
      });
    }

    const current = await getPurchaseOrder(http, po.purchaseorder_id);
    if (!current || current.last_modified_time !== request.expected_version) {
      await cancelCreated(http, created);
      return { status: "conflict", current_version: current?.last_modified_time ?? null, message: "Purchase order changed in Zoho during the split" };
    }
    const marker = `${MARKER_PREFIX}${request.change_ref}: ${JSON.stringify({ line: line.line_item_id, deliveries })}`;
    const updated = (await http.send("PUT", `/purchaseorders/${po.purchaseorder_id}`, zohoPurchaseOrderResponseSchema, {
      body: {
        vendor_id: po.vendor_id,
        ...(po.purchaseorder_number ? { purchaseorder_number: po.purchaseorder_number } : {}),
        delivery_date: deliveries[0].due,
        notes: po.notes ? `${po.notes}\n${marker}` : marker,
        line_items: po.line_items.map((candidate) =>
          writeLine(candidate, candidate === line
            ? line.quantity - lineOpenQty(line) + first.quantity
            : candidate.quantity),
        ),
      },
    })).purchaseorder;
    return {
      status: "applied",
      provider_ref: po.purchaseorder_id,
      version: updated.last_modified_time,
      deliveries: deliveries.map(toApplied),
    };
  } catch (error) {
    if (error instanceof ZohoApiError && created.length > 0 && !(await cancelCreated(http, created))) {
      return { status: "unknown", message: `Zoho rejected the split and follow-up POs ${created.join(", ")} could not be cancelled` };
    }
    return failure(error);
  }
}

async function cancelCreated(http: ZohoHttp, ids: string[]): Promise<boolean> {
  try {
    for (const id of ids) await http.send("POST", `/purchaseorders/${id}/status/cancelled`, zohoEnvelopeSchema);
    return true;
  } catch {
    return false;
  }
}

function failure(error: unknown): DeliverySplitResult {
  if (error instanceof ZohoTransportError) return { status: "unknown", message: error.message };
  if (error instanceof ZohoApiError) {
    return { status: "rejected", code: error.httpStatus === 429 ? "rate_limited" : "provider_rejected", message: error.message };
  }
  throw error;
}

async function listReceipts(http: ZohoHttp, limits: ZohoClientLimits, since: string | null): Promise<ErpReceipt[]> {
  const sinceMs = since ? Date.parse(since) : null;
  const summaries = (await listAll<z.infer<typeof zohoReceiveListSchema>["purchasereceives"][number]>(
    http, limits, "/purchasereceives", zohoReceiveListSchema, "purchasereceives",
  )).filter((summary) => {
    if (summary.status.toLowerCase() !== "received") return false;
    const changed = zohoTimeMs(summary.last_modified_time ?? summary.created_time);
    return sinceMs === null || changed === null || changed >= sinceMs;
  });
  const receipts: ErpReceipt[] = [];
  for (const summary of capDetails(summaries, limits, "purchase receives")) {
    const { purchasereceive: receive } = await http.get(`/purchasereceives/${summary.receive_id}`, zohoReceiveResponseSchema);
    const receivedAt = dateToIso(receive.date);
    if (!receivedAt) continue;
    for (const line of receive.line_items) {
      if (line.quantity <= 0) continue;
      receipts.push({
        external_receipt_id: `${receive.receive_id}:${line.line_item_id}`,
        po_external_id: receive.purchaseorder_id,
        line_external_id: line.line_item_id,
        quantity: intQty(line.quantity, "received quantity"),
        received_at: receivedAt,
        kind: "received",
      });
    }
  }
  return receipts;
}
