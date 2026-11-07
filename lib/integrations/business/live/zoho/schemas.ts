import { z } from "zod";

/** Zoho returns IDs as strings; tolerate numeric IDs from older payloads. */
const id = z.union([z.string().min(1), z.number().int().nonnegative()]).transform(String);
const optionalId = z.union([id, z.literal(""), z.null()]).optional()
  .transform((value) => (value ? value : null));
const optionalText = z.string().nullish().transform((value) => value ?? "");
const optionalDate = z.string().nullish().transform((value) => (value ? value : null));
const quantity = z.number().finite().nonnegative();

export const zohoCredentialsSchema = z.object({
  refresh_token: z.string().min(1),
  api_domain: z.string().url(),
  accounts_server: z.string().url(),
  organization_id: z.string().regex(/^\d+$/),
});
export type ZohoCredentials = z.infer<typeof zohoCredentialsSchema>;

export const zohoTokenResponseSchema = z.union([
  z.object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    api_domain: z.string().url().optional(),
    token_type: z.string().optional(),
    expires_in: z.number().int().positive().optional(),
    scope: z.string().optional(),
  }),
  z.object({ error: z.string().min(1) }),
]);

export const zohoEnvelopeSchema = z.object({
  code: z.number().int(),
  message: z.string().optional().default(""),
});

export const zohoPageContextSchema = z.object({
  page_context: z.object({ has_more_page: z.boolean().optional().default(false) }).optional(),
});

export const zohoOrganizationSchema = z.object({
  organization_id: id,
  name: optionalText,
  is_default_org: z.boolean().optional().default(false),
  currency_code: z.string().optional(),
});
export const zohoOrganizationsResponseSchema = z.object({
  organizations: z.array(zohoOrganizationSchema),
});

export const zohoLocationSchema = z.object({
  location_id: id,
  location_name: optionalText,
  status: z.string().optional().default("active"),
});
export const zohoLocationsResponseSchema = z.object({
  locations: z.array(zohoLocationSchema).optional().default([]),
});

export const zohoPurchaseOrderSummarySchema = z.object({
  purchaseorder_id: id,
  status: z.string(),
  reference_number: optionalText,
});
export const zohoPurchaseOrderListSchema = zohoPageContextSchema.extend({
  purchaseorders: z.array(zohoPurchaseOrderSummarySchema).optional().default([]),
});

export const zohoPurchaseOrderLineSchema = z.object({
  line_item_id: id,
  item_id: id,
  name: optionalText,
  sku: optionalText,
  unit: optionalText,
  quantity,
  quantity_received: quantity.optional().default(0),
  quantity_cancelled: quantity.optional().default(0),
  purchase_rate: z.number().finite().nonnegative().optional(),
  rate: z.number().finite().nonnegative().optional(),
  account_id: optionalId,
  tax_id: optionalId,
  location_id: optionalId,
  warehouse_id: optionalId,
});
export type ZohoPurchaseOrderLine = z.infer<typeof zohoPurchaseOrderLineSchema>;

export const zohoPurchaseOrderSchema = z.object({
  purchaseorder_id: id,
  purchaseorder_number: optionalText,
  status: z.string(),
  vendor_id: id,
  vendor_name: optionalText,
  currency_code: z.string().regex(/^[A-Z]{3}$/).optional(),
  reference_number: optionalText,
  date: optionalDate,
  delivery_date: optionalDate,
  expected_delivery_date: optionalDate,
  notes: optionalText,
  last_modified_time: z.string().min(1),
  location_id: optionalId,
  line_items: z.array(zohoPurchaseOrderLineSchema),
});
export type ZohoPurchaseOrder = z.infer<typeof zohoPurchaseOrderSchema>;
export const zohoPurchaseOrderResponseSchema = z.object({ purchaseorder: zohoPurchaseOrderSchema });

export const zohoItemSummarySchema = z.object({ item_id: id });
export const zohoItemListSchema = zohoPageContextSchema.extend({
  items: z.array(zohoItemSummarySchema).optional().default([]),
});
export const zohoItemSchema = z.object({
  item_id: id,
  name: optionalText,
  sku: optionalText,
  unit: optionalText,
  locations: z.array(z.object({
    location_id: id,
    location_name: optionalText,
    location_stock_on_hand: z.number().finite().optional().default(0),
  })).optional().default([]),
});
export const zohoItemResponseSchema = z.object({ item: zohoItemSchema });

export const zohoSalesOrderSummarySchema = z.object({ salesorder_id: id, status: z.string() });
export const zohoSalesOrderListSchema = zohoPageContextSchema.extend({
  salesorders: z.array(zohoSalesOrderSummarySchema).optional().default([]),
});
export const zohoSalesOrderSchema = z.object({
  salesorder_id: id,
  status: z.string(),
  shipment_date: optionalDate,
  date: optionalDate,
  location_id: optionalId,
  line_items: z.array(z.object({
    line_item_id: id,
    item_id: id,
    quantity,
    quantity_shipped: quantity.optional().default(0),
    quantity_cancelled: quantity.optional().default(0),
    location_id: optionalId,
    warehouse_id: optionalId,
  })),
});
export const zohoSalesOrderResponseSchema = z.object({ salesorder: zohoSalesOrderSchema });

// The list endpoint names the id purchasereceive_id; the detail endpoint names it receive_id.
export const zohoReceiveSummarySchema = z
  .object({
    purchasereceive_id: id.optional(),
    receive_id: id.optional(),
    purchaseorder_id: id.optional(),
    status: z.string().optional().default("received"),
    last_modified_time: z.string().optional(),
    created_time: z.string().optional(),
  })
  .transform(({ purchasereceive_id, receive_id, ...rest }) => ({ ...rest, receive_id: purchasereceive_id ?? receive_id }))
  .refine((summary): summary is typeof summary & { receive_id: string } => summary.receive_id !== undefined, "missing receive id");
export const zohoReceiveListSchema = zohoPageContextSchema.extend({
  purchasereceives: z.array(zohoReceiveSummarySchema).optional().default([]),
});
export const zohoReceiveSchema = z.object({
  receive_id: id,
  purchaseorder_id: id,
  date: z.string().min(1),
  status: z.string().optional().default("received"),
  line_items: z.array(z.object({ line_item_id: id, item_id: optionalId, quantity })),
});
export const zohoReceiveResponseSchema = z.object({ purchasereceive: zohoReceiveSchema });
