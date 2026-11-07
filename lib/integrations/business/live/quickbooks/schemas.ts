import { z } from "zod";
import { qboEnvironmentSchema } from "./config";

const ref = z.looseObject({ value: z.string().min(1), name: z.string().optional() });
const qty = z.number().finite();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}/);
const meta = z.looseObject({ CreateTime: z.string().optional(), LastUpdatedTime: z.string().optional() });
const linkedTxn = z.looseObject({ TxnId: z.string(), TxnType: z.string(), TxnLineId: z.string().optional() });

export const qboTokenResponseSchema = z.looseObject({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.number().int().positive(),
  x_refresh_token_expires_in: z.number().int().positive().optional(),
});
export type QboTokenResponse = z.infer<typeof qboTokenResponseSchema>;

/** Decrypted credential blob stored per connection. */
export const qboCredentialsSchema = z.object({
  provider: z.literal("quickbooks"),
  realm_id: z.string().regex(/^\d+$/),
  environment: qboEnvironmentSchema,
  refresh_token: z.string().min(1),
  refresh_token_expires_at: z.string().nullable(),
  access_token: z.string().min(1).nullable(),
  access_token_expires_at: z.string().nullable(),
});
export type QboCredentials = z.infer<typeof qboCredentialsSchema>;

export const qboFaultSchema = z.looseObject({
  Fault: z.looseObject({
    Error: z.array(z.looseObject({
      Message: z.string().optional(),
      Detail: z.string().optional(),
      code: z.string().optional(),
      element: z.string().optional(),
    })).default([]),
    type: z.string().optional(),
  }),
});

export const qboItemLineSchema = z.looseObject({
  Id: z.string().optional(),
  LineNum: z.number().optional(),
  Description: z.string().optional(),
  Amount: z.number().optional(),
  DetailType: z.string(),
  LinkedTxn: z.array(linkedTxn).optional(),
  ItemBasedExpenseLineDetail: z.looseObject({
    ItemRef: ref,
    Qty: qty.optional(),
    UnitPrice: z.number().optional(),
  }).optional(),
});
export type QboLine = z.infer<typeof qboItemLineSchema>;

export const qboPurchaseOrderSchema = z.looseObject({
  Id: z.string().min(1),
  SyncToken: z.string().min(1),
  DocNumber: z.string().optional(),
  TxnDate: date.optional(),
  DueDate: date.optional(),
  POStatus: z.string().optional(),
  PrivateNote: z.string().optional(),
  VendorRef: ref,
  CurrencyRef: ref.optional(),
  Line: z.array(qboItemLineSchema).default([]),
  LinkedTxn: z.array(linkedTxn).optional(),
  MetaData: meta.optional(),
});
export type QboPurchaseOrder = z.infer<typeof qboPurchaseOrderSchema>;

export const qboBillSchema = z.looseObject({
  Id: z.string().min(1),
  SyncToken: z.string().optional(),
  TxnDate: date.optional(),
  Line: z.array(qboItemLineSchema).default([]),
  MetaData: meta.optional(),
});
export type QboBill = z.infer<typeof qboBillSchema>;

export const qboItemSchema = z.looseObject({
  Id: z.string().min(1),
  Name: z.string(),
  Sku: z.string().optional(),
  Type: z.string().optional(),
  Active: z.boolean().optional(),
  TrackQtyOnHand: z.boolean().optional(),
  QtyOnHand: qty.optional(),
});

export const qboVendorSchema = z.looseObject({
  Id: z.string().min(1),
  DisplayName: z.string(),
  Active: z.boolean().optional(),
  PrimaryEmailAddr: z.looseObject({ Address: z.string().optional() }).optional(),
  PrimaryPhone: z.looseObject({ FreeFormNumber: z.string().optional() }).optional(),
});

export const qboCompanyInfoSchema = z.looseObject({
  Id: z.string().optional(),
  CompanyName: z.string(),
  Country: z.string().optional(),
});

export const qboPreferencesSchema = z.looseObject({
  CurrencyPrefs: z.looseObject({ HomeCurrency: ref.optional() }).optional(),
});

export const qboEntitySchemas = {
  PurchaseOrder: qboPurchaseOrderSchema,
  Bill: qboBillSchema,
  Item: qboItemSchema,
  Vendor: qboVendorSchema,
  CompanyInfo: qboCompanyInfoSchema,
  Preferences: qboPreferencesSchema,
} as const;
export type QboEntityName = keyof typeof qboEntitySchemas;
export type QboEntity<N extends QboEntityName> = z.infer<(typeof qboEntitySchemas)[N]>;
