import { z } from "zod";

export const SHOPIFY_API_VERSION = "2026-10";

const SHOP_DOMAIN = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;

export function isShopDomain(value: unknown): value is string {
  return typeof value === "string" && SHOP_DOMAIN.test(value);
}

export class ShopifyApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ShopifyApiError";
  }
}

const responseSchema = z.object({
  data: z.unknown().optional(),
  errors: z
    .array(z.object({ message: z.string(), extensions: z.object({ code: z.string().optional() }).passthrough().optional() }).passthrough())
    .optional(),
});

export interface ShopifyGraphql {
  <T>(operationName: string, query: string, variables: Record<string, unknown>, schema: z.ZodType<T>): Promise<T>;
}

export function createShopifyGraphql(input: { shop: string; accessToken: string; fetch?: typeof fetch }): ShopifyGraphql {
  if (!isShopDomain(input.shop)) throw new ShopifyApiError("Invalid shop domain", "invalid_shop", false);
  const url = `https://${input.shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const doFetch = input.fetch ?? fetch;
  return async (operationName, query, variables, schema) => {
    const response = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-shopify-access-token": input.accessToken },
      body: JSON.stringify({ operationName, query, variables }),
    });
    if (response.status === 401 || response.status === 403) {
      throw new ShopifyApiError(`Shopify rejected the access token (${response.status})`, "unauthorized", false);
    }
    if (response.status === 429 || response.status >= 500) {
      throw new ShopifyApiError(`Shopify returned ${response.status}`, `http_${response.status}`, true);
    }
    if (!response.ok) throw new ShopifyApiError(`Shopify returned ${response.status}`, `http_${response.status}`, false);
    const body = responseSchema.parse(await response.json());
    if (body.errors?.length) {
      const code = body.errors[0].extensions?.code ?? "graphql_error";
      throw new ShopifyApiError(body.errors.map((e) => e.message).join("; "), code, code === "THROTTLED" || code === "INTERNAL_SERVER_ERROR");
    }
    return schema.parse(body.data);
  };
}

const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const id = z.string().min(1);
const int = z.number().int();
const nullableDate = z.string().datetime({ offset: true }).nullable().optional();
const money = z.object({ amount: z.string(), currencyCode: z.string() }).nullable().optional();

export const LOCATIONS_QUERY = `query ConduitLocations($after: String) {
  locations(first: 100, after: $after) { nodes { id name isActive } pageInfo { hasNextPage endCursor } }
}`;
export const locationsSchema = z.object({
  locations: z.object({ nodes: z.array(z.object({ id, name: z.string(), isActive: z.boolean() })), pageInfo }),
});

export const INVENTORY_ITEMS_QUERY = `query ConduitInventoryItems($after: String) {
  inventoryItems(first: 50, after: $after) {
    nodes {
      id sku tracked
      variant { displayName }
      inventoryLevels(first: 50) {
        nodes { location { id } quantities(names: ["on_hand", "damaged", "quality_control"]) { name quantity } }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;
export const inventoryItemsSchema = z.object({
  inventoryItems: z.object({
    nodes: z.array(
      z.object({
        id,
        sku: z.string().nullable(),
        tracked: z.boolean(),
        variant: z.object({ displayName: z.string() }).nullable(),
        inventoryLevels: z.object({
          nodes: z.array(
            z.object({ location: z.object({ id }), quantities: z.array(z.object({ name: z.string(), quantity: int })) }),
          ),
        }),
      }),
    ),
    pageInfo,
  }),
});

const TRANSFER_FIELDS = `fragment ConduitTransfer on InventoryTransfer {
  id name status
  origin { name location { id } }
  destination { name location { id } }
  lineItems(first: 100) {
    nodes { id totalQuantity shippedQuantity processableQuantity pickedForShipmentQuantity inventoryItem { id unitCost { amount currencyCode } } }
  }
  shipments(first: 100) {
    nodes {
      id name status barcode dateReceived
      tracking { arrivesAt }
      lineItems(first: 100) {
        nodes { id quantity acceptedQuantity rejectedQuantity canceledQuantity unreceivedQuantity inventoryItem { id } }
      }
    }
  }
}`;

const shipmentSchema = z.object({
  id,
  name: z.string(),
  status: z.string(),
  barcode: z.string().nullable(),
  dateReceived: nullableDate,
  tracking: z.object({ arrivesAt: nullableDate }).nullable(),
  lineItems: z.object({
    nodes: z.array(
      z.object({
        id,
        quantity: int,
        acceptedQuantity: int,
        rejectedQuantity: int,
        canceledQuantity: int,
        unreceivedQuantity: int,
        inventoryItem: z.object({ id }).nullable(),
      }),
    ),
  }),
});
export type ShopifyShipment = z.infer<typeof shipmentSchema>;

const snapshotSchema = z.object({ name: z.string().nullable().optional(), location: z.object({ id }).nullable() }).nullable();

export const transferSchema = z.object({
  id,
  name: z.string(),
  status: z.string(),
  origin: snapshotSchema,
  destination: snapshotSchema,
  lineItems: z.object({
    nodes: z.array(
      z.object({
        id,
        totalQuantity: int,
        shippedQuantity: int,
        processableQuantity: int,
        pickedForShipmentQuantity: int,
        inventoryItem: z.object({ id, unitCost: money }).nullable(),
      }),
    ),
  }),
  shipments: z.object({ nodes: z.array(shipmentSchema) }),
});
export type ShopifyTransfer = z.infer<typeof transferSchema>;

export const TRANSFERS_QUERY = `${TRANSFER_FIELDS}
query ConduitTransfers($after: String) {
  shop { currencyCode }
  inventoryTransfers(first: 25, after: $after) { nodes { ...ConduitTransfer } pageInfo { hasNextPage endCursor } }
}`;
export const transfersSchema = z.object({
  shop: z.object({ currencyCode: z.string() }),
  inventoryTransfers: z.object({ nodes: z.array(transferSchema), pageInfo }),
});

export const TRANSFER_QUERY = `${TRANSFER_FIELDS}
query ConduitTransfer($id: ID!) {
  shop { currencyCode }
  inventoryTransfer(id: $id) { ...ConduitTransfer }
}`;
export const transferByIdSchema = z.object({
  shop: z.object({ currencyCode: z.string() }),
  inventoryTransfer: transferSchema.nullable(),
});

export const FULFILLMENT_ORDERS_QUERY = `query ConduitFulfillmentOrders($after: String) {
  fulfillmentOrders(first: 50, after: $after) {
    nodes {
      id status fulfillBy fulfillAt orderProcessedAt
      assignedLocation { location { id } }
      lineItems(first: 100) { nodes { id remainingQuantity inventoryItemId } }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;
export const fulfillmentOrdersSchema = z.object({
  fulfillmentOrders: z.object({
    nodes: z.array(
      z.object({
        id,
        status: z.string(),
        fulfillBy: nullableDate,
        fulfillAt: nullableDate,
        orderProcessedAt: nullableDate,
        assignedLocation: z.object({ location: z.object({ id }).nullable() }),
        lineItems: z.object({
          nodes: z.array(z.object({ id, remainingQuantity: int, inventoryItemId: z.string().nullable() })),
        }),
      }),
    ),
    pageInfo,
  }),
});

export const SHIPMENT_CREATE_MUTATION = `mutation ConduitShipmentCreate($input: InventoryShipmentCreateInput!, $idempotencyKey: String!) {
  inventoryShipmentCreate(input: $input) @idempotent(key: $idempotencyKey) {
    inventoryShipment { id }
    userErrors { field message code }
  }
}`;
export const shipmentCreateSchema = z.object({
  inventoryShipmentCreate: z.object({
    inventoryShipment: z.object({ id }).nullable(),
    userErrors: z.array(z.object({ message: z.string(), code: z.string().nullable().optional() })),
  }),
});

export async function paginate<T, N>(
  fetchPage: (after: string | null) => Promise<T>,
  select: (page: T) => { nodes: N[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } },
  maxPages = 40,
): Promise<{ nodes: N[]; first: T }> {
  const nodes: N[] = [];
  let after: string | null = null;
  let first: T | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = await fetchPage(after);
    first ??= page;
    const { nodes: pageNodes, pageInfo: info } = select(page);
    nodes.push(...pageNodes);
    if (!info.hasNextPage || !info.endCursor) break;
    after = info.endCursor;
  }
  return { nodes, first: first! };
}
