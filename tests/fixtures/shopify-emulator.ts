import type { ShopifyTransfer } from "@/lib/integrations/business/live/shopify/graphql";

/**
 * Mocked Shopify Admin GraphQL (no network). Responses follow the 2026-10 documented shapes for
 * the operations the connector sends; it is not a recording of a real store.
 */
export interface ShopifyEmulatorOptions {
  now?: () => Date;
}

type Body = { operationName: string; query: string; variables: Record<string, unknown> };

export function createShopifyEmulator({ now = () => new Date() }: ShopifyEmulatorOptions = {}) {
  let seq = 100;
  const gid = (type: string) => `gid://shopify/${type}/${++seq}`;
  const requests: Array<Body & { headers: Record<string, string>; url: string }> = [];
  const idempotency = new Map<string, unknown>();
  let failNextCreate: "network" | { code: string; message: string } | null = null;

  const locations = [
    { id: "gid://shopify/Location/1", name: "Main warehouse", isActive: true },
    { id: "gid://shopify/Location/2", name: "Old shop", isActive: false },
  ];
  const items = [
    {
      id: "gid://shopify/InventoryItem/11",
      sku: "BOLT-M8",
      tracked: true,
      variant: { displayName: "M8 bolt - Default Title" },
      inventoryLevels: {
        nodes: [
          {
            location: { id: "gid://shopify/Location/1" },
            quantities: [
              { name: "on_hand", quantity: 240 },
              { name: "damaged", quantity: 3 },
              { name: "quality_control", quantity: 2 },
            ],
          },
        ],
      },
    },
    { id: "gid://shopify/InventoryItem/12", sku: null, tracked: false, variant: null, inventoryLevels: { nodes: [] } },
  ];
  const transfers: ShopifyTransfer[] = [];
  const fulfillmentOrders = [
    {
      id: "gid://shopify/FulfillmentOrder/31",
      status: "OPEN",
      fulfillBy: "2030-01-12T17:00:00Z",
      fulfillAt: null,
      orderProcessedAt: "2030-01-05T10:00:00Z",
      assignedLocation: { location: { id: "gid://shopify/Location/1" } },
      lineItems: { nodes: [{ id: "gid://shopify/FulfillmentOrderLineItem/41", remainingQuantity: 500, inventoryItemId: "gid://shopify/InventoryItem/11" }] },
    },
    {
      id: "gid://shopify/FulfillmentOrder/32",
      status: "CLOSED",
      fulfillBy: null,
      fulfillAt: null,
      orderProcessedAt: "2030-01-01T10:00:00Z",
      assignedLocation: { location: { id: "gid://shopify/Location/1" } },
      lineItems: { nodes: [{ id: "gid://shopify/FulfillmentOrderLineItem/42", remainingQuantity: 9, inventoryItemId: "gid://shopify/InventoryItem/11" }] },
    },
  ];

  function addTransfer(input: { quantity: number; status?: string; supplier?: string | null; originLocationId?: string }) {
    const transfer: ShopifyTransfer = {
      id: gid("InventoryTransfer"),
      name: `#T${seq}`,
      status: input.status ?? "READY_TO_SHIP",
      origin: input.originLocationId
        ? { name: "Other store", location: { id: input.originLocationId } }
        : { name: input.supplier === undefined ? "Acme Fasteners" : input.supplier, location: null },
      destination: { name: "Main warehouse", location: { id: "gid://shopify/Location/1" } },
      lineItems: {
        nodes: [
          {
            id: gid("InventoryTransferLineItem"),
            totalQuantity: input.quantity,
            shippedQuantity: 0,
            processableQuantity: input.quantity,
            pickedForShipmentQuantity: 0,
            inventoryItem: { id: "gid://shopify/InventoryItem/11", unitCost: { amount: "0.42", currencyCode: "USD" } },
          },
        ],
      },
      shipments: { nodes: [] },
    };
    transfers.push(transfer);
    return { transferId: transfer.id, lineId: transfer.lineItems.nodes[0].id };
  }

  function addShipment(transfer: ShopifyTransfer, itemId: string, quantity: number, barcode: string | null, arrivesAt: string | null) {
    const line = transfer.lineItems.nodes.find((l) => l.inventoryItem?.id === itemId)!;
    line.processableQuantity -= quantity;
    line.pickedForShipmentQuantity += quantity;
    const shipment = {
      id: gid("InventoryShipment"),
      name: `${transfer.name}-${transfer.shipments.nodes.length + 1}`,
      status: "DRAFT",
      barcode,
      dateReceived: null as string | null,
      tracking: { arrivesAt },
      lineItems: {
        nodes: [
          {
            id: gid("InventoryShipmentLineItem"),
            quantity,
            acceptedQuantity: 0,
            rejectedQuantity: 0,
            canceledQuantity: 0,
            unreceivedQuantity: quantity,
            inventoryItem: { id: itemId },
          },
        ],
      },
    };
    transfer.shipments.nodes.push(shipment);
    return shipment;
  }

  function shipmentCreate(variables: Record<string, unknown>) {
    const key = String(variables.idempotencyKey ?? "");
    if (!key) return { errors: [{ message: "idempotency key required", extensions: { code: "BAD_REQUEST" } }] };
    if (idempotency.has(key)) return { data: idempotency.get(key) };
    const input = variables.input as {
      movementId: string;
      barcode: string;
      lineItems: Array<{ inventoryItemId: string; quantity: number }>;
      trackingInput?: { arrivesAt?: string };
    };
    const userError = (code: string, message: string) => ({ inventoryShipmentCreate: { inventoryShipment: null, userErrors: [{ field: ["input"], message, code }] } });
    const transfer = transfers.find((t) => t.id === input.movementId);
    let data;
    if (!transfer) data = userError("TRANSFER_NOT_FOUND", "Transfer not found");
    else if (!["READY_TO_SHIP", "IN_PROGRESS"].includes(transfer.status)) data = userError("INVALID_TRANSFER_STATUS", "Transfer must be ready to ship");
    else if (transfers.some((t) => t.shipments.nodes.some((s) => s.barcode === input.barcode))) data = userError("BARCODE_DUPLICATE", "Barcode already used");
    else {
      const [li] = input.lineItems;
      const line = transfer.lineItems.nodes.find((l) => l.inventoryItem?.id === li.inventoryItemId);
      if (!line || li.quantity > line.processableQuantity) data = userError("INVALID_QUANTITY", "Quantity exceeds what is left to ship");
      else {
        const shipment = addShipment(transfer, li.inventoryItemId, li.quantity, input.barcode, input.trackingInput?.arrivesAt ?? null);
        if (transfer.status === "READY_TO_SHIP") transfer.status = "IN_PROGRESS";
        data = { inventoryShipmentCreate: { inventoryShipment: { id: shipment.id }, userErrors: [] } };
      }
    }
    idempotency.set(key, data);
    return { data };
  }

  function page<T>(nodes: T[]) {
    return { nodes: structuredClone(nodes), pageInfo: { hasNextPage: false, endCursor: null } };
  }

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Body;
    requests.push({ ...body, url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    const shop = { currencyCode: "USD" };
    let payload: unknown;
    switch (body.operationName) {
      case "ConduitLocations":
        payload = { data: { locations: page(locations) } };
        break;
      case "ConduitInventoryItems":
        payload = { data: { inventoryItems: page(items) } };
        break;
      case "ConduitTransfers":
        payload = { data: { shop, inventoryTransfers: page(transfers) } };
        break;
      case "ConduitTransfer":
        payload = { data: { shop, inventoryTransfer: structuredClone(transfers.find((t) => t.id === body.variables.id) ?? null) } };
        break;
      case "ConduitFulfillmentOrders":
        payload = { data: { fulfillmentOrders: page(fulfillmentOrders) } };
        break;
      case "ConduitShipmentCreate": {
        const fail = failNextCreate;
        failNextCreate = null;
        if (fail === "network") {
          shipmentCreate(body.variables);
          throw new TypeError("fetch failed");
        }
        if (fail) {
          payload = { data: { inventoryShipmentCreate: { inventoryShipment: null, userErrors: [{ field: null, ...fail }] } } };
          break;
        }
        payload = shipmentCreate(body.variables);
        break;
      }
      default:
        payload = { errors: [{ message: `Unknown operation ${body.operationName}` }] };
    }
    return Response.json(payload);
  }) as typeof fetch;

  return {
    fetch: fetchImpl,
    requests,
    transfers,
    addTransfer,
    failNextCreate(mode: "network" | { code: string; message: string }) {
      failNextCreate = mode;
    },
    receive(transferId: string, quantity: number) {
      const transfer = transfers.find((t) => t.id === transferId)!;
      const itemId = transfer.lineItems.nodes[0].inventoryItem!.id;
      const shipment = addShipment(transfer, itemId, quantity, null, null);
      const line = shipment.lineItems.nodes[0];
      line.acceptedQuantity = quantity;
      line.unreceivedQuantity = 0;
      shipment.status = "RECEIVED";
      shipment.dateReceived = now().toISOString();
    },
    touch(transferId: string) {
      const line = transfers.find((t) => t.id === transferId)!.lineItems.nodes[0];
      line.totalQuantity += 1;
      line.processableQuantity += 1;
    },
  };
}
