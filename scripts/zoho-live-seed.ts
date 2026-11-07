import { z } from "zod";
import {
  LIVE_ITEM_NAME,
  LIVE_PO_REFERENCE,
  LIVE_VENDOR_NAME,
  assertLiveTestPo,
  liveZoho,
} from "../tests/domain/zoho/live-guard";

import type { ZohoQuery } from "../lib/integrations/business/live/zoho/http";

// Seeds the PO used by tests/domain/zoho/live.test.ts in a REAL Zoho test org. Dry run unless --send.
const any = z.record(z.string(), z.unknown());
const created = z.object({ purchaseorder: z.object({ purchaseorder_id: z.string() }) });

async function main() {
  const { credentials, http } = liveZoho(process.env);
  const rows = async (path: string, key: string, query: ZohoQuery = {}) =>
    z.array(any).parse((await http.get(path, any, query))[key] ?? []);
  const vendors = (await rows("/contacts", "contacts", { contact_type: "vendor" })).filter((c) => c.contact_name === LIVE_VENDOR_NAME);
  const items = (await rows("/items", "items")).filter((i) => i.name === LIVE_ITEM_NAME);
  if (vendors.length !== 1 || items.length !== 1) {
    throw new Error(`need exactly one vendor and item, got ${vendors.length}/${items.length}`);
  }
  const body = {
    vendor_id: String(vendors[0].contact_id),
    reference_number: LIVE_PO_REFERENCE,
    date: new Date().toISOString().slice(0, 10),
    delivery_date: "2030-01-20",
    notes: "Conduit AT-37 contract test PO (test org).",
    line_items: [{ item_id: String(items[0].item_id), quantity: 10, purchase_rate: 5 }],
  };
  console.log(`org ${credentials.organization_id} via ${credentials.api_domain}`);
  console.log("PLAN POST /purchaseorders", JSON.stringify(body));
  console.log("PLAN POST /purchaseorders/<new id>/status/issued");
  if (!process.argv.includes("--send")) return;
  const poId = (await http.send("POST", "/purchaseorders", created, { body })).purchaseorder.purchaseorder_id;
  await http.send("POST", `/purchaseorders/${poId}/status/issued`, any);
  const read = z
    .object({ purchaseorder: z.object({ line_items: z.array(z.object({ line_item_id: z.string() })).length(1) }) })
    .parse(await http.get(`/purchaseorders/${poId}`, any));
  const lineId = read.purchaseorder.line_items[0].line_item_id;
  await assertLiveTestPo(http, poId, lineId);
  console.log(JSON.stringify({ po_id: poId, line_id: lineId }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
