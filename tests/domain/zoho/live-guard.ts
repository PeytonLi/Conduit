import { z } from "zod";
import {
  zohoAppConfig,
  zohoCredentialsSchema,
  type ZohoCredentials,
} from "@/lib/integrations/business/live/zoho";
import { zohoInventoryBaseUrl } from "@/lib/integrations/business/live/zoho/domains";
import { createZohoHttp, type ZohoHttp } from "@/lib/integrations/business/live/zoho/http";

export const LIVE_PO_REFERENCE = "CONDUIT-AT37-TEST";
export const LIVE_VENDOR_NAME = "Test Vendor";
export const LIVE_ITEM_NAME = "Test Widget";

export interface LiveZoho {
  credentials: ZohoCredentials;
  deps: Parameters<typeof createZohoHttp>[0];
  http: ZohoHttp;
}

/** Refuses to build a REAL Zoho client unless the operator-declared org and API domain match the stored credential. */
export function liveZoho(env: NodeJS.ProcessEnv): LiveZoho {
  const config = zohoAppConfig(env);
  if (!config) throw new Error("ZOHO_CLIENT_ID/ZOHO_CLIENT_SECRET missing");
  const credentials = zohoCredentialsSchema.parse(JSON.parse(env.ZOHO_LIVE_CREDENTIALS ?? "{}"));
  const expectedOrg = z.string().regex(/^\d+$/).parse(env.ZOHO_LIVE_ORG_ID);
  const expectedBase = zohoInventoryBaseUrl(z.string().parse(env.ZOHO_LIVE_API_DOMAIN));
  if (credentials.organization_id !== expectedOrg) throw new Error("credential organization_id is not ZOHO_LIVE_ORG_ID");
  if (!expectedBase || zohoInventoryBaseUrl(credentials.api_domain) !== expectedBase) {
    throw new Error("credential api_domain is not ZOHO_LIVE_API_DOMAIN");
  }
  const deps = { credentials, ...config, fetch, now: () => new Date() };
  return { credentials, deps, http: createZohoHttp(deps) };
}

const livePoSchema = z.object({
  purchaseorder: z.object({
    purchaseorder_id: z.string(),
    reference_number: z.string().nullish(),
    vendor_name: z.string(),
    vendor_id: z.string(),
    notes: z.string().nullish(),
    line_items: z.array(z.object({ line_item_id: z.string(), item_id: z.string(), name: z.string() })),
  }),
});

/** Throws unless poId is the seeded contract-test PO from the test vendor and lineId is its test item line. */
export async function assertLiveTestPo(http: ZohoHttp, poId: string, lineId: string) {
  const { purchaseorder: po } = await http.get(`/purchaseorders/${poId}`, livePoSchema);
  const line = po.line_items.find((l) => l.line_item_id === lineId);
  if (po.reference_number !== LIVE_PO_REFERENCE || po.vendor_name !== LIVE_VENDOR_NAME || line?.name !== LIVE_ITEM_NAME) {
    throw new Error(`PO ${poId} is not the ${LIVE_PO_REFERENCE} test PO; refusing to write`);
  }
  return po;
}
