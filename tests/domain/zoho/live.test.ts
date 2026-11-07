import { describe } from "vitest";
import { z } from "zod";
import { describeErpClientContract } from "@/lib/integrations/business/live/contract";
import { createZohoInventoryClient } from "@/lib/integrations/business/live/zoho";
import { zohoEnvelopeSchema } from "@/lib/integrations/business/live/zoho/schemas";
import { assertLiveTestPo, liveZoho } from "./live-guard";

/**
 * REAL Zoho Inventory run. Skipped unless ZOHO_LIVE_TEST=1. Writes to the PO named in ZOHO_LIVE_PO_ID
 * (notes edit, delivery split + follow-up PO, one purchase receive). Seed a fresh PO with
 * scripts/zoho-live-seed.ts before each run; the guard refuses any other org or PO.
 */
const live = process.env.ZOHO_LIVE_TEST === "1";
// One http + client per run: Zoho caps access-token refreshes per refresh token (about 10 per 10 minutes).
let shared: { zoho: ReturnType<typeof liveZoho>; client: ReturnType<typeof createZohoInventoryClient> } | undefined;

describe.skipIf(!live)("Zoho Inventory ErpClient contract (REAL Zoho test organization)", { timeout: 120_000 }, () => {
  describeErpClientContract(async () => {
    if (!shared) {
      const zoho = liveZoho(process.env);
      shared = { zoho, client: createZohoInventoryClient(zoho.deps) };
    }
    const { http } = shared.zoho;
    const poId = z.string().regex(/^\d+$/).parse(process.env.ZOHO_LIVE_PO_ID);
    const lineId = z.string().regex(/^\d+$/).parse(process.env.ZOHO_LIVE_LINE_ID);
    await assertLiveTestPo(http, poId, lineId);
    return {
      client: shared.client,
      poExternalId: poId,
      lineExternalId: lineId,
      touch: async () => {
        const po = await assertLiveTestPo(http, poId, lineId);
        await http.send("PUT", `/purchaseorders/${poId}`, zohoEnvelopeSchema, {
          body: {
            vendor_id: po.vendor_id,
            notes: `${po.notes ?? ""}\nContract touch ${new Date().toISOString()}`.trim(),
          },
        });
      },
      receive: async (quantity) => {
        await assertLiveTestPo(http, poId, lineId);
        await http.send("POST", "/purchasereceives", zohoEnvelopeSchema, {
          query: { purchaseorder_id: poId, ignore_auto_number_generation: "true" },
          body: {
            receive_number: `CDT-RCV-${Date.now()}`,
            date: new Date().toISOString().slice(0, 10),
            line_items: [{ line_item_id: lineId, quantity }],
          },
        });
      },
    };
  });
});
