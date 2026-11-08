import type { TransferCapabilities } from "@/lib/domain/transfers";
import type { ErpProvider } from "./types";

/**
 * What Conduit does for an internal stock transfer, per business system. This is the documented
 * contract; a connection can still be recommend-only at runtime (for example a Shopify token that
 * was never granted write_inventory_transfers), which the transfer gate reports with a reason.
 */
export type TransferSupport =
  | { mode: "execute"; capabilities: TransferCapabilities; note: string }
  | { mode: "recommend_only"; reason: string };

export const erpTransferSupport: Record<ErpProvider, TransferSupport> = {
  shopify: {
    mode: "execute",
    capabilities: { reserve: true, dispatch: true, receive: true },
    note:
      "inventoryTransferCreateAsReadyToShip reserves source stock, inventoryShipmentCreateInTransit dispatches it, and the " +
      "shipment's accepted quantities read back receiving. Needs the write_inventory_transfers scope.",
  },
  odoo: {
    mode: "recommend_only",
    reason: "The Odoo connector does not create internal transfers (stock.picking); an owner moves the stock in Odoo.",
  },
  zoho_inventory: {
    mode: "recommend_only",
    reason: "The Zoho Inventory connector does not create transfer orders; an owner moves the stock in Zoho.",
  },
  quickbooks: {
    mode: "recommend_only",
    reason: "QuickBooks Online has no location-to-location transfer the connector can write; an owner moves the stock.",
  },
};

export function transferSupportFor(provider: ErpProvider): TransferSupport {
  return erpTransferSupport[provider];
}
