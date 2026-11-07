/**
 * Provider-neutral contract every real business-system connector (Odoo, Zoho Inventory,
 * QuickBooks Online) implements. Quantities are integers in the line's unit; money is integer
 * minor units as a string; timestamps are ISO 8601 with offset.
 */
export type ErpProvider = "odoo" | "zoho_inventory" | "quickbooks" | "shopify";

export interface ErpLocation {
  external_id: string;
  name: string;
}

export interface ErpItem {
  external_id: string;
  sku: string;
  name: string;
  unit: string;
}

export interface ErpSupplier {
  external_id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
}

export interface ErpPurchaseOrderLine {
  external_line_id: string;
  item_external_id: string;
  ordered_qty: number;
  received_qty: number;
  unit_price_minor: string;
  /** Expected delivery for this line; header date when the system has no per-line date. */
  due_at: string | null;
  destination_external_id: string;
}

export interface ErpPurchaseOrder {
  external_id: string;
  supplier_external_id: string;
  currency: string;
  status: string;
  /** Opaque optimistic-concurrency token (Odoo write_date, Zoho last_modified_time, QBO SyncToken). */
  version: string;
  lines: ErpPurchaseOrderLine[];
}

export interface ErpStockLevel {
  item_external_id: string;
  location_external_id: string;
  on_hand_qty: number;
  unusable_qty?: number;
}

export interface ErpDemand {
  external_id: string;
  item_external_id: string;
  location_external_id: string;
  quantity: number;
  required_at: string;
  certainty: "confirmed" | "forecast";
}

export interface ErpSnapshot {
  as_of: string;
  locations: ErpLocation[];
  items: ErpItem[];
  suppliers: ErpSupplier[];
  purchase_orders: ErpPurchaseOrder[];
  stock: ErpStockLevel[];
  demand: ErpDemand[];
}

export interface DeliveryWindow {
  quantity: number;
  earliest_at: string;
  latest_at: string;
}

/**
 * Replace one PO line's remaining quantity with dated deliveries (e.g. 600 Wednesday + 3,400
 * Friday). `change_ref` is Conduit's action id: the client must stamp it on what it writes so
 * findChange can locate the change after a timeout, and re-applying the same ref must not
 * duplicate anything.
 */
export interface DeliverySplitRequest {
  change_ref: string;
  po_external_id: string;
  line_external_id: string;
  expected_version: string;
  schedules: DeliveryWindow[];
}

export interface AppliedDelivery {
  /** Provider record holding this delivery (PO line, or a second PO where lines have no dates). */
  external_ref: string;
  quantity: number;
  due_at: string | null;
}

export type DeliverySplitResult =
  | { status: "applied"; provider_ref: string; version: string; deliveries: AppliedDelivery[] }
  | { status: "conflict"; current_version: string | null; message: string }
  | { status: "rejected"; code: string; message: string }
  | { status: "unknown"; message: string };

export type ChangeLookup =
  | { status: "applied"; provider_ref: string; deliveries: AppliedDelivery[] }
  | { status: "not_found" };

export interface ErpReceipt {
  external_receipt_id: string;
  po_external_id: string;
  line_external_id: string;
  quantity: number;
  received_at: string;
  kind: "received" | "reversal";
  reverses_external_id?: string;
}

export interface ErpClient {
  provider: ErpProvider;
  readSnapshot(): Promise<ErpSnapshot>;
  readPurchaseOrder(poExternalId: string): Promise<ErpPurchaseOrder | null>;
  /** Must refuse with `conflict` when the PO's current version differs from expected_version. */
  applyDeliverySplit(request: DeliverySplitRequest): Promise<DeliverySplitResult>;
  findChange(changeRef: string, poExternalId: string): Promise<ChangeLookup>;
  listReceipts(since: string | null): Promise<ErpReceipt[]>;
}

/** What each provider module exports so the shared registry can build a client per connection. */
export interface ErpProviderDefinition {
  provider: ErpProvider;
  label: string;
  /** Builds a client from the connection's decrypted credentials; throws when they are invalid. */
  createClient(
    credentials: unknown,
    deps?: {
      fetch?: typeof fetch;
      now?: () => Date;
      /** Persists rotated credentials (e.g. a refreshed OAuth token) for this connection; rejects if not saved. */
      saveCredentials?: (credentials: unknown, expiresAt: string | null) => Promise<void>;
    },
  ): ErpClient;
}
