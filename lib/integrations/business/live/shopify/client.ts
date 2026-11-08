import { createHash } from "node:crypto";
import { parseMajorDecimal } from "@/lib/domain/money";
import { changeStamp, idempotencyKey } from "./stamp";
import { createShopifyTransferApi } from "./transfers";
import type {
  AppliedDelivery,
  ChangeLookup,
  DeliverySplitRequest,
  DeliverySplitResult,
  ErpClient,
  ErpDemand,
  ErpItem,
  ErpPurchaseOrder,
  ErpReceipt,
  ErpSnapshot,
  ErpStockLevel,
  ErpSupplier,
} from "../types";
import {
  FULFILLMENT_ORDERS_QUERY,
  INVENTORY_ITEMS_QUERY,
  LOCATIONS_QUERY,
  SHIPMENT_CREATE_MUTATION,
  TRANSFERS_QUERY,
  TRANSFER_QUERY,
  ShopifyApiError,
  fulfillmentOrdersSchema,
  inventoryItemsSchema,
  locationsSchema,
  paginate,
  shipmentCreateSchema,
  transferByIdSchema,
  transfersSchema,
  type ShopifyGraphql,
  type ShopifyShipment,
  type ShopifyTransfer,
} from "./graphql";

/** Transfers Shopify still expects stock on; DRAFT ones cannot take shipments yet. */
const OPEN_TRANSFER = new Set(["DRAFT", "READY_TO_SHIP", "IN_PROGRESS"]);
const WRITABLE_TRANSFER = new Set(["READY_TO_SHIP", "IN_PROGRESS"]);
const OPEN_FULFILLMENT = new Set(["OPEN", "IN_PROGRESS", "SCHEDULED", "ON_HOLD"]);

export { changeStamp };

/** Hash of every transfer field a split depends on; Shopify transfers expose no updatedAt. */
export function transferVersion(t: ShopifyTransfer): string {
  const shape = {
    s: t.status,
    l: t.lineItems.nodes.map((l) => [l.id, l.totalQuantity, l.shippedQuantity, l.processableQuantity, l.pickedForShipmentQuantity]),
    sh: t.shipments.nodes.map((s) => [
      s.id,
      s.status,
      s.barcode,
      s.tracking?.arrivesAt ?? null,
      s.lineItems.nodes.map((l) => [l.id, l.quantity, l.acceptedQuantity, l.rejectedQuantity, l.canceledQuantity]),
    ]),
  };
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 32);
}

function supplierId(t: ShopifyTransfer): string {
  const name = t.origin?.name?.trim() || "Unknown supplier";
  return `shopify-supplier:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

function shipmentLinesFor(t: ShopifyTransfer, itemId: string) {
  return t.shipments.nodes.flatMap((s) =>
    s.lineItems.nodes.filter((l) => l.inventoryItem?.id === itemId).map((l) => ({ shipment: s, line: l })),
  );
}

function minorUnits(amount: string | undefined, currency: string): string {
  if (!amount) return "0";
  try {
    return parseMajorDecimal(amount, currency).toString();
  } catch {
    const fixed = Number(amount).toFixed(2);
    return parseMajorDecimal(fixed, currency).toString();
  }
}

/** Only transfers with no Shopify origin location are supplier deliveries; others are internal moves. */
function isSupplierTransfer(t: ShopifyTransfer): boolean {
  return !t.origin?.location && !!t.destination?.location && OPEN_TRANSFER.has(t.status);
}

export function mapTransfer(t: ShopifyTransfer, shopCurrency: string): ErpPurchaseOrder {
  const destination = t.destination?.location?.id ?? "";
  const currency = t.lineItems.nodes.find((l) => l.inventoryItem?.unitCost)?.inventoryItem?.unitCost?.currencyCode ?? shopCurrency;
  return {
    external_id: t.id,
    supplier_external_id: supplierId(t),
    currency,
    status: t.status.toLowerCase(),
    version: transferVersion(t),
    lines: t.lineItems.nodes
      .filter((l) => l.inventoryItem)
      .map((l) => {
        const itemId = l.inventoryItem!.id;
        const shipped = shipmentLinesFor(t, itemId);
        const canceled = shipped.reduce((s, x) => s + x.line.canceledQuantity, 0);
        const received = shipped.reduce((s, x) => s + x.line.acceptedQuantity + x.line.rejectedQuantity, 0);
        const due = shipped
          .filter((x) => x.line.unreceivedQuantity > 0 && x.shipment.tracking?.arrivesAt)
          .map((x) => x.shipment.tracking!.arrivesAt!)
          .sort()[0];
        return {
          external_line_id: l.id,
          item_external_id: itemId,
          ordered_qty: Math.max(0, l.totalQuantity - canceled),
          received_qty: received,
          unit_price_minor: minorUnits(l.inventoryItem!.unitCost?.amount, l.inventoryItem!.unitCost?.currencyCode ?? currency),
          due_at: due ?? null,
          destination_external_id: destination,
        };
      }),
  };
}

function stampedShipments(t: ShopifyTransfer, changeRef: string) {
  const prefix = `${changeStamp(changeRef)}-`;
  return t.shipments.nodes
    .map((s) => {
      const match = s.barcode?.startsWith(prefix) ? /^(\d+)of(\d+)$/.exec(s.barcode.slice(prefix.length)) : null;
      return match ? { shipment: s, index: Number(match[1]), total: Number(match[2]) } : null;
    })
    .filter((x): x is { shipment: ShopifyShipment; index: number; total: number } => x !== null)
    .sort((a, b) => a.index - b.index);
}

function deliveriesOf(stamped: ReturnType<typeof stampedShipments>): AppliedDelivery[] {
  return stamped.map(({ shipment }) => ({
    external_ref: shipment.id,
    quantity: shipment.lineItems.nodes.reduce((s, l) => s + l.quantity, 0),
    due_at: shipment.tracking?.arrivesAt ?? null,
  }));
}

function lookup(t: ShopifyTransfer, changeRef: string): ChangeLookup {
  const stamped = stampedShipments(t, changeRef);
  const total = stamped[0]?.total ?? 0;
  if (stamped.length === 0 || new Set(stamped.map((s) => s.index)).size !== total) return { status: "not_found" };
  return { status: "applied", provider_ref: `${t.id}#${changeStamp(changeRef)}`, deliveries: deliveriesOf(stamped) };
}

export interface ShopifyClientDeps {
  graphql: ShopifyGraphql;
  now?: () => Date;
  /**
   * The token was granted write_inventory_transfers and write_inventory_shipments. Without it the
   * client stays recommend-only for internal transfers and exposes no `transfers` API.
   */
  transferScopeGranted?: boolean;
}

export function createShopifyErpClient({ graphql, now = () => new Date(), transferScopeGranted = false }: ShopifyClientDeps): ErpClient {
  async function readTransfer(id: string) {
    const data = await graphql("ConduitTransfer", TRANSFER_QUERY, { id }, transferByIdSchema);
    return { transfer: data.inventoryTransfer, currency: data.shop.currencyCode };
  }

  async function readTransfers() {
    const { nodes, first } = await paginate(
      (after) => graphql("ConduitTransfers", TRANSFERS_QUERY, { after }, transfersSchema),
      (p) => p.inventoryTransfers,
    );
    return { transfers: nodes, currency: first.shop.currencyCode };
  }

  async function createShipments(
    transfer: ShopifyTransfer,
    request: DeliverySplitRequest,
    itemId: string,
    skip: Set<number>,
  ): Promise<DeliverySplitResult | null> {
    const stamp = changeStamp(request.change_ref);
    const n = request.schedules.length;
    let created = skip.size;
    for (let i = 0; i < n; i++) {
      if (skip.has(i + 1)) continue;
      const schedule = request.schedules[i];
      let result;
      try {
        result = await graphql(
          "ConduitShipmentCreate",
          SHIPMENT_CREATE_MUTATION,
          {
            idempotencyKey: idempotencyKey(request.change_ref, i + 1),
            input: {
              movementId: transfer.id,
              barcode: `${stamp}-${i + 1}of${n}`,
              lineItems: [{ inventoryItemId: itemId, quantity: schedule.quantity }],
              trackingInput: { arrivesAt: schedule.latest_at },
            },
          },
          shipmentCreateSchema,
        );
      } catch (err) {
        return { status: "unknown", message: `Shopify did not confirm shipment ${i + 1} of ${n}: ${(err as Error).message}` };
      }
      const payload = result.inventoryShipmentCreate;
      if (payload.userErrors.some((e) => e.code === "BARCODE_DUPLICATE")) {
        created++;
        continue;
      }
      if (payload.userErrors.length > 0 || !payload.inventoryShipment) {
        const message = payload.userErrors.map((e) => e.message).join("; ") || "Shopify returned no shipment";
        if (created === 0) {
          return { status: "rejected", code: `shopify_${(payload.userErrors[0]?.code ?? "user_error").toLowerCase()}`, message };
        }
        return { status: "unknown", message: `Shipment ${i + 1} of ${n} failed after earlier ones were created: ${message}` };
      }
      created++;
    }
    return null;
  }

  return {
    provider: "shopify",
    ...(transferScopeGranted ? { transfers: createShopifyTransferApi({ graphql }) } : {}),

    async readSnapshot(): Promise<ErpSnapshot> {
      const asOf = now().toISOString();
      const locations = await paginate(
        (after) => graphql("ConduitLocations", LOCATIONS_QUERY, { after }, locationsSchema),
        (p) => p.locations,
      );
      const items = await paginate(
        (after) => graphql("ConduitInventoryItems", INVENTORY_ITEMS_QUERY, { after }, inventoryItemsSchema),
        (p) => p.inventoryItems,
      );
      const { transfers, currency } = await readTransfers();
      const orders = await paginate(
        (after) => graphql("ConduitFulfillmentOrders", FULFILLMENT_ORDERS_QUERY, { after }, fulfillmentOrdersSchema),
        (p) => p.fulfillmentOrders,
      );

      const erpItems: ErpItem[] = [];
      const stock: ErpStockLevel[] = [];
      for (const item of items.nodes) {
        if (!item.tracked) continue;
        erpItems.push({
          external_id: item.id,
          sku: item.sku || item.id,
          name: item.variant?.displayName ?? item.sku ?? item.id,
          unit: "each",
        });
        for (const level of item.inventoryLevels.nodes) {
          const q = (name: string) => level.quantities.find((x) => x.name === name)?.quantity ?? 0;
          stock.push({
            item_external_id: item.id,
            location_external_id: level.location.id,
            on_hand_qty: Math.max(0, q("on_hand")),
            unusable_qty: Math.max(0, q("damaged") + q("quality_control")),
          });
        }
      }

      const purchaseOrders = transfers.filter(isSupplierTransfer).map((t) => mapTransfer(t, currency));
      const suppliers = new Map<string, ErpSupplier>();
      for (const t of transfers.filter(isSupplierTransfer)) {
        suppliers.set(supplierId(t), { external_id: supplierId(t), name: t.origin?.name?.trim() || "Unknown supplier" });
      }

      const demand: ErpDemand[] = [];
      for (const fo of orders.nodes) {
        if (!OPEN_FULFILLMENT.has(fo.status)) continue;
        const location = fo.assignedLocation.location?.id;
        const requiredAt = fo.fulfillBy ?? fo.fulfillAt ?? fo.orderProcessedAt;
        if (!location || !requiredAt) continue;
        for (const line of fo.lineItems.nodes) {
          if (!line.inventoryItemId || line.remainingQuantity <= 0) continue;
          demand.push({
            external_id: line.id,
            item_external_id: line.inventoryItemId,
            location_external_id: location,
            quantity: line.remainingQuantity,
            required_at: new Date(requiredAt).toISOString(),
            certainty: "confirmed",
          });
        }
      }

      return {
        as_of: asOf,
        locations: locations.nodes.filter((l) => l.isActive).map((l) => ({ external_id: l.id, name: l.name })),
        items: erpItems,
        suppliers: [...suppliers.values()],
        purchase_orders: purchaseOrders,
        stock,
        demand,
      };
    },

    async readPurchaseOrder(poExternalId) {
      const { transfer, currency } = await readTransfer(poExternalId);
      return transfer ? mapTransfer(transfer, currency) : null;
    },

    async applyDeliverySplit(request): Promise<DeliverySplitResult> {
      const { transfer } = await readTransfer(request.po_external_id);
      if (!transfer) return { status: "rejected", code: "po_not_found", message: "Shopify transfer not found" };
      const line = transfer.lineItems.nodes.find((l) => l.id === request.line_external_id);
      if (!line?.inventoryItem) return { status: "rejected", code: "line_not_found", message: "Transfer line not found" };
      const itemId = line.inventoryItem.id;
      const n = request.schedules.length;

      const existing = stampedShipments(transfer, request.change_ref);
      if (existing.length > 0 && existing.some((s) => s.total !== n)) {
        return { status: "rejected", code: "change_ref_reused", message: "change_ref already used for a different split" };
      }
      if (existing.length < n) {
        if (existing.length === 0) {
          const current = transferVersion(transfer);
          if (current !== request.expected_version) {
            return { status: "conflict", current_version: current, message: "The Shopify transfer changed since it was read" };
          }
          if (!WRITABLE_TRANSFER.has(transfer.status)) {
            return {
              status: "rejected",
              code: transfer.status === "DRAFT" ? "transfer_not_ready" : "transfer_closed",
              message: `Shopify transfer is ${transfer.status.toLowerCase()}`,
            };
          }
          if (n === 0 || request.schedules.some((s) => !Number.isInteger(s.quantity) || s.quantity <= 0 || Number.isNaN(Date.parse(s.latest_at)))) {
            return { status: "rejected", code: "invalid_schedule", message: "Each delivery needs a positive integer quantity and a date" };
          }
          const open = mapTransfer(transfer, "USD").lines.find((l) => l.external_line_id === line.id)!;
          const remaining = open.ordered_qty - open.received_qty;
          if (line.processableQuantity !== remaining) {
            return {
              status: "rejected",
              code: "quantity_already_on_shipments",
              message: "Part of this line is already on a Shopify shipment; re-date that shipment in Shopify",
            };
          }
          if (request.schedules.reduce((s, x) => s + x.quantity, 0) !== remaining) {
            return { status: "rejected", code: "quantity_mismatch", message: `Deliveries must add up to the ${remaining} units still open` };
          }
        }
        const failed = await createShipments(transfer, request, itemId, new Set(existing.map((s) => s.index)));
        if (failed) return failed;
      }

      let readback;
      try {
        readback = (await readTransfer(request.po_external_id)).transfer;
      } catch (err) {
        return { status: "unknown", message: `Shipments were sent but readback failed: ${(err as Error).message}` };
      }
      const found = readback ? lookup(readback, request.change_ref) : ({ status: "not_found" } as const);
      if (!readback || found.status !== "applied") {
        return { status: "unknown", message: "Shopify accepted the shipments but they are not visible on readback yet" };
      }
      return { status: "applied", provider_ref: found.provider_ref, version: transferVersion(readback), deliveries: found.deliveries };
    },

    async findChange(changeRef, poExternalId) {
      const { transfer } = await readTransfer(poExternalId);
      return transfer ? lookup(transfer, changeRef) : { status: "not_found" };
    },

    async listReceipts(since) {
      const { transfers } = await readTransfers();
      const sinceMs = since ? Date.parse(since) : null;
      const receipts: ErpReceipt[] = [];
      for (const t of transfers) {
        if (t.origin?.location) continue;
        for (const line of t.lineItems.nodes) {
          if (!line.inventoryItem) continue;
          for (const { shipment, line: sl } of shipmentLinesFor(t, line.inventoryItem.id)) {
            if (sl.acceptedQuantity <= 0) continue;
            const receivedAt = shipment.dateReceived ?? null;
            if (sinceMs !== null && shipment.status !== "PARTIALLY_RECEIVED" && (!receivedAt || Date.parse(receivedAt) < sinceMs)) continue;
            receipts.push({
              external_receipt_id: sl.id,
              po_external_id: t.id,
              line_external_id: line.id,
              quantity: sl.acceptedQuantity,
              received_at: receivedAt ? new Date(receivedAt).toISOString() : now().toISOString(),
              kind: "received",
            });
          }
        }
      }
      return receipts;
    },
  };
}

export { ShopifyApiError };
