import type { ErpTransferApi, TransferLookup, TransferRecord, TransferRequest, TransferResult, TransferState } from "../types";
import {
  INVENTORY_LEVEL_QUERY,
  SHIPMENT_CREATE_IN_TRANSIT_MUTATION,
  TRANSFERS_QUERY,
  TRANSFER_CREATE_MUTATION,
  TRANSFER_QUERY,
  inventoryLevelSchema,
  paginate,
  shipmentCreateInTransitSchema,
  transferByIdSchema,
  transferCreateSchema,
  transfersSchema,
  type ShopifyGraphql,
  type ShopifyShipment,
  type ShopifyTransfer,
} from "./graphql";
import { changeStamp, idempotencyKey } from "./stamp";

/**
 * Internal (location to location) transfers on Shopify. Conduit creates a READY_TO_SHIP transfer,
 * which reserves the stock at the origin, then an in-transit shipment, which dispatches it.
 * Everything is stamped with the change reference so a lost response can be reconciled by reading
 * Shopify, never by writing again.
 */

const ref = (transferId: string, stamp: string) => `${transferId}#${stamp}`;

function stampedShipment(transfer: ShopifyTransfer, stamp: string): ShopifyShipment | null {
  return transfer.shipments.nodes.find((s) => s.barcode?.startsWith(`${stamp}-`)) ?? null;
}

function stateOf(transfer: ShopifyTransfer, shipment: ShopifyShipment | null): TransferState {
  if (transfer.status === "CANCELED") return "cancelled";
  if (!shipment) return "reserved";
  switch (shipment.status) {
    case "RECEIVED":
      return "received";
    case "PARTIALLY_RECEIVED":
      return "partially_received";
    case "IN_TRANSIT":
      return "in_transit";
    default:
      // DRAFT or a status Conduit does not know is not proof the stock left the origin.
      return "reserved";
  }
}

/** Exported for tests: maps a Shopify transfer that carries `stamp` to the provider-neutral record. */
export function transferRecord(transfer: ShopifyTransfer, stamp: string): TransferRecord {
  const shipment = stampedShipment(transfer, stamp);
  return {
    provider_ref: ref(transfer.id, stamp),
    transfer_external_id: transfer.id,
    shipment_external_id: shipment?.id ?? null,
    state: stateOf(transfer, shipment),
    quantity: transfer.lineItems.nodes.reduce((sum, l) => sum + l.totalQuantity, 0),
    received_qty: shipment?.lineItems.nodes.reduce((sum, l) => sum + l.acceptedQuantity, 0) ?? 0,
    arrives_at: shipment?.tracking?.arrivesAt ?? null,
  };
}

const isInternal = (t: ShopifyTransfer) => Boolean(t.origin?.location && t.destination?.location);

export function createShopifyTransferApi({ graphql }: { graphql: ShopifyGraphql }): ErpTransferApi {
  async function findStamped(stamp: string, providerRef?: string | null): Promise<ShopifyTransfer | null> {
    const hinted = providerRef?.split("#")[0];
    if (hinted?.startsWith("gid://")) {
      const data = await graphql("ConduitTransfer", TRANSFER_QUERY, { id: hinted }, transferByIdSchema);
      const t = data.inventoryTransfer;
      if (t && isInternal(t) && t.referenceName === stamp) return t;
    }
    const { nodes } = await paginate(
      (after) => graphql("ConduitTransfers", TRANSFERS_QUERY, { after }, transfersSchema),
      (p) => p.inventoryTransfers,
    );
    return nodes.find((t) => isInternal(t) && t.referenceName === stamp) ?? null;
  }

  async function readback(stamp: string, providerRef: string): Promise<TransferLookup> {
    const found = await findStamped(stamp, providerRef);
    return found ? { status: "found", ...transferRecord(found, stamp) } : { status: "not_found" };
  }

  async function dispatchShipment(request: TransferRequest, transferId: string, stamp: string): Promise<TransferResult | null> {
    let result;
    try {
      result = await graphql(
        "ConduitShipmentCreateInTransit",
        SHIPMENT_CREATE_IN_TRANSIT_MUTATION,
        {
          idempotencyKey: idempotencyKey(request.change_ref, 2),
          input: {
            movementId: transferId,
            barcode: `${stamp}-1of1`,
            lineItems: [{ inventoryItemId: request.item_external_id, quantity: request.quantity }],
            trackingInput: { arrivesAt: request.arrives_at },
          },
        },
        shipmentCreateInTransitSchema,
      );
    } catch (err) {
      return {
        status: "unknown",
        message: `Shopify reserved the stock but did not confirm the shipment: ${(err as Error).message}`,
      };
    }
    const payload = result.inventoryShipmentCreateInTransit;
    const duplicate = payload.userErrors.some((e) => e.code === "BARCODE_DUPLICATE");
    if (!duplicate && (payload.userErrors.length > 0 || !payload.inventoryShipment)) {
      return {
        status: "unknown",
        message: `Shopify reserved the stock but rejected the shipment: ${payload.userErrors.map((e) => e.message).join("; ") || "no shipment returned"}`,
      };
    }
    return null;
  }

  return {
    capabilities: { reserve: true, dispatch: true, receive: true },

    async findTransfer(changeRef, providerRef) {
      const stamp = changeStamp(changeRef);
      return readback(stamp, providerRef ?? "");
    },

    async createTransfer(request): Promise<TransferResult> {
      if (
        !Number.isInteger(request.quantity) ||
        request.quantity <= 0 ||
        Number.isNaN(Date.parse(request.arrives_at)) ||
        request.source_location_external_id === request.destination_location_external_id
      ) {
        return { status: "rejected", code: "invalid_transfer", message: "A transfer needs a positive whole quantity, an arrival time and two different locations" };
      }
      const stamp = changeStamp(request.change_ref);

      let existing: ShopifyTransfer | null;
      try {
        existing = await findStamped(stamp);
      } catch (err) {
        // Nothing has been written yet, so this is a clean failure rather than an unknown outcome.
        return { status: "rejected", code: "shopify_read_failed", message: `Could not check Shopify before writing: ${(err as Error).message}` };
      }

      let transferId = existing?.id ?? null;
      if (existing && stateOf(existing, stampedShipment(existing, stamp)) !== "reserved") {
        return { status: "applied", ...transferRecord(existing, stamp) };
      }

      if (!transferId) {
        try {
          const level = await graphql(
            "ConduitInventoryLevel",
            INVENTORY_LEVEL_QUERY,
            { itemId: request.item_external_id, locationId: request.source_location_external_id },
            inventoryLevelSchema,
          );
          const quantities = level.inventoryItem?.inventoryLevel?.quantities;
          if (!level.inventoryItem?.tracked || !quantities) {
            return { status: "rejected", code: "source_not_stocked", message: "The source location does not track this item" };
          }
          const q = (name: string) => quantities.find((x) => x.name === name)?.quantity ?? 0;
          if (q("on_hand") - request.quantity < request.min_source_on_hand_after) {
            return {
              status: "rejected",
              code: "source_stock_changed",
              message: "Source stock changed since approval; moving this quantity would leave the source short",
            };
          }
          if (q("available") < request.quantity) {
            return { status: "rejected", code: "source_stock_unavailable", message: "The source does not have this quantity available" };
          }
        } catch (err) {
          return { status: "rejected", code: "shopify_read_failed", message: `Could not re-read source stock: ${(err as Error).message}` };
        }

        let created;
        try {
          created = await graphql(
            "ConduitTransferCreate",
            TRANSFER_CREATE_MUTATION,
            {
              idempotencyKey: idempotencyKey(request.change_ref, 1),
              input: {
                originLocationId: request.source_location_external_id,
                destinationLocationId: request.destination_location_external_id,
                lineItems: [{ inventoryItemId: request.item_external_id, quantity: request.quantity }],
                referenceName: stamp,
                tags: ["conduit", stamp],
                note: "Created by Conduit after owner approval",
              },
            },
            transferCreateSchema,
          );
        } catch (err) {
          // The request may have reached Shopify; only a read can tell.
          return { status: "unknown", message: `Shopify did not confirm the transfer: ${(err as Error).message}` };
        }
        const payload = created.inventoryTransferCreateAsReadyToShip;
        if (payload.userErrors.length > 0 || !payload.inventoryTransfer) {
          return {
            status: "rejected",
            code: `shopify_${(payload.userErrors[0]?.code ?? "user_error").toLowerCase()}`,
            message: payload.userErrors.map((e) => e.message).join("; ") || "Shopify returned no transfer",
          };
        }
        transferId = payload.inventoryTransfer.id;
      }

      const failedDispatch = await dispatchShipment(request, transferId, stamp);
      if (failedDispatch) return failedDispatch;

      let back: TransferLookup;
      try {
        back = await readback(stamp, ref(transferId, stamp));
      } catch (err) {
        return { status: "unknown", message: `The transfer was sent but readback failed: ${(err as Error).message}` };
      }
      if (back.status !== "found" || back.state === "reserved" || back.state === "cancelled") {
        return { status: "unknown", message: "Shopify accepted the transfer but it is not visible as in transit on readback yet" };
      }
      const { status: _status, ...record } = back;
      void _status;
      return { status: "applied", ...record };
    },
  };
}
