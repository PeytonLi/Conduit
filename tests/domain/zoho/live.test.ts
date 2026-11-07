import { describe } from "vitest";
import { z } from "zod";
import { describeErpClientContract } from "@/lib/integrations/business/live/contract";
import {
  createZohoInventoryClient,
  zohoAppConfig,
  zohoCredentialsSchema,
} from "@/lib/integrations/business/live/zoho";
import { createZohoHttp } from "@/lib/integrations/business/live/zoho/http";
import { zohoEnvelopeSchema } from "@/lib/integrations/business/live/zoho/schemas";

/**
 * REAL Zoho Inventory run. Skipped unless ZOHO_LIVE_TEST=1. Writes to the PO named in
 * ZOHO_LIVE_PO_ID (notes edit, delivery split + follow-up PO, one purchase receive), so point it
 * only at a test organization after the audit step.
 */
const live = process.env.ZOHO_LIVE_TEST === "1";

describe.skipIf(!live)("Zoho Inventory ErpClient contract (REAL Zoho test organization)", () => {
  describeErpClientContract(async () => {
    const config = zohoAppConfig(process.env);
    if (!config) throw new Error("ZOHO_CLIENT_ID/ZOHO_CLIENT_SECRET missing");
    const credentials = zohoCredentialsSchema.parse(JSON.parse(process.env.ZOHO_LIVE_CREDENTIALS ?? "{}"));
    const poId = z.string().regex(/^\d+$/).parse(process.env.ZOHO_LIVE_PO_ID);
    const lineId = z.string().regex(/^\d+$/).parse(process.env.ZOHO_LIVE_LINE_ID);
    const deps = { credentials, ...config, fetch, now: () => new Date() };
    const http = createZohoHttp(deps);
    const poSchema = z.object({ purchaseorder: z.object({ notes: z.string().nullish(), vendor_id: z.string() }) });
    return {
      client: createZohoInventoryClient(deps),
      poExternalId: poId,
      lineExternalId: lineId,
      touch: async () => {
        const { purchaseorder } = await http.get(`/purchaseorders/${poId}`, poSchema);
        await http.send("PUT", `/purchaseorders/${poId}`, zohoEnvelopeSchema, {
          body: {
            vendor_id: purchaseorder.vendor_id,
            notes: `${purchaseorder.notes ?? ""}\nContract touch ${new Date().toISOString()}`.trim(),
          },
        });
      },
      receive: async (quantity) => {
        await http.send("POST", "/purchasereceives", zohoEnvelopeSchema, {
          query: { purchaseorder_id: poId },
          body: {
            date: new Date().toISOString().slice(0, 10),
            line_items: [{ line_item_id: lineId, quantity }],
          },
        });
      },
    };
  });
});
