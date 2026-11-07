import { describe, expect, it } from "vitest";
import { z } from "zod";
import { describeErpClientContract } from "@/lib/integrations/business/live/contract";
import { createOdooErpClient, createOdooTransport, odooCredentialsSchema, verifyOdooConnection } from "@/lib/integrations/business/live/odoo";

// Real Odoo, opt-in. Start one with scripts/odoo-local/setup.sh, then
// `source scripts/odoo-local/.state/env` before running this file.
const url = process.env.ODOO_CONTRACT_URL;

describe.skipIf(!url)("Odoo ErpClient contract (real Odoo at ODOO_CONTRACT_URL)", () => {
  const credentials = odooCredentialsSchema.parse({
    url: url ?? "http://127.0.0.1:8069",
    database: process.env.ODOO_CONTRACT_DB ?? "unset",
    username: process.env.ODOO_CONTRACT_LOGIN ?? "admin",
    api_key: process.env.ODOO_CONTRACT_API_KEY ?? "unset".repeat(4),
  });
  const transport = createOdooTransport(credentials);
  const client = createOdooErpClient(transport);
  const one = z.array(z.object({ id: z.number().int() }).passthrough());

  // Contract writes and receipts use their own product so the README dataset stays as seeded.
  async function contractProduct() {
    const [existing] = await transport.call("product.product", "search_read", { domain: [["default_code", "=", "CARTON-CONTRACT"]], fields: ["id"], limit: 1 }, one);
    if (existing) return existing;
    const [id] = await transport.call(
      "product.product",
      "create",
      { vals_list: [{ name: "Contract test carton", default_code: "CARTON-CONTRACT", type: "consu", is_storable: true, purchase_method: "receive" }] },
      z.array(z.number().int()).length(1),
    );
    return { id };
  }

  async function freshPurchaseOrder() {
    const [vendor] = await transport.call("res.partner", "search_read", { domain: [["name", "=", "Bay Carton Supply"]], fields: ["id"], limit: 1 }, one);
    const product = await contractProduct();
    const [poId] = await transport.call(
      "purchase.order",
      "create",
      {
        vals_list: [{
          partner_id: vendor.id,
          partner_ref: "contract-test",
          order_line: [[0, 0, { product_id: product.id, product_qty: 4000, price_unit: 0.42, date_planned: "2030-01-14 17:00:00" }]],
        }],
      },
      z.array(z.number().int()).length(1),
    );
    await transport.call("purchase.order", "button_confirm", { ids: [poId] }, z.unknown());
    const [po] = await transport.call("purchase.order", "read", { ids: [poId], fields: ["order_line"] }, z.array(z.object({ order_line: z.array(z.number().int()).length(1) })));
    return { poId, lineId: po.order_line[0] };
  }

  async function receive(poId: number, lineId: number, quantity: number) {
    const moveSchema = z.array(z.object({ id: z.number().int(), picking_id: z.union([z.tuple([z.number().int(), z.string()]), z.literal(false)]), purchase_line_id: z.unknown() }));
    const [move] = await transport.call("stock.move", "search_read", {
      domain: [["purchase_line_id", "=", lineId], ["state", "not in", ["done", "cancel"]]],
      fields: ["picking_id", "purchase_line_id"],
      order: "date asc, id asc",
      limit: 1,
    }, moveSchema);
    if (!move || move.picking_id === false) throw new Error(`No open receipt move for PO ${poId}`);
    const pickingId = move.picking_id[0];
    const others = await transport.call("stock.move", "search_read", { domain: [["picking_id", "=", pickingId], ["id", "!=", move.id]], fields: ["picking_id", "purchase_line_id"] }, moveSchema);
    if (others.length) await transport.call("stock.move", "write", { ids: others.map((m) => m.id), vals: { quantity: 0, picked: false } }, z.literal(true));
    await transport.call("stock.move", "write", { ids: [move.id], vals: { quantity, picked: true } }, z.literal(true));
    await transport.call("stock.picking", "button_validate", { ids: [pickingId], context: { skip_backorder: true } }, z.unknown());
  }

  it("connects with the local credentials", async () => {
    const verified = await verifyOdooConnection(credentials);
    expect(verified.ok).toBe(true);
  });

  it("reads the seeded README example: 600 on hand, 4,000 due Tuesday, 400 a day Tue-Thu", async () => {
    const snapshot = await client.readSnapshot();
    const carton = snapshot.items.find((i) => i.sku === "CARTON-302015")!;
    expect(snapshot.stock.find((s) => s.item_external_id === carton.external_id)?.on_hand_qty).toBe(600);
    const seeded = snapshot.purchase_orders.find((p) => p.lines.some((l) => l.item_external_id === carton.external_id && l.ordered_qty === 4000 && l.received_qty === 0 && l.due_at?.slice(0, 10) !== "2030-01-14"));
    expect(seeded).toBeTruthy();
    expect(new Date(seeded!.lines[0].due_at!).getUTCDay()).toBe(2);
    expect(seeded!.lines[0].unit_price_minor).toBe("42");
    const demand = snapshot.demand.filter((d) => d.item_external_id === carton.external_id);
    expect(demand.map((d) => d.quantity)).toEqual([400, 400, 400]);
    expect(demand.map((d) => new Date(d.required_at).getUTCDay())).toEqual([2, 3, 4]);
  });

  it("keeps receiving correct after a split: one dated receipt move per delivery and no vendor return", async () => {
    const { poId, lineId } = await freshPurchaseOrder();
    const po = (await client.readPurchaseOrder(String(poId)))!;
    const applied = await client.applyDeliverySplit({
      change_ref: `odoo-receiving-${Date.now()}`,
      po_external_id: String(poId),
      line_external_id: String(lineId),
      expected_version: po.version,
      schedules: [
        { quantity: 600, earliest_at: "2030-01-15T17:00:00.000Z", latest_at: "2030-01-15T17:00:00.000Z" },
        { quantity: 3400, earliest_at: "2030-01-17T17:00:00.000Z", latest_at: "2030-01-17T17:00:00.000Z" },
      ],
    });
    expect(applied.status).toBe("applied");
    const moves = await transport.call(
      "stock.move",
      "search_read",
      { domain: [["purchase_line_id.order_id", "=", poId], ["state", "!=", "cancel"]], fields: ["product_uom_qty", "date", "location_dest_id"], order: "date asc" },
      z.array(z.object({ product_uom_qty: z.number(), date: z.string(), location_dest_id: z.tuple([z.number(), z.string()]) })),
    );
    expect(moves.map((m) => [m.product_uom_qty, m.date])).toEqual([[600, "2030-01-15 17:00:00"], [3400, "2030-01-17 17:00:00"]]);
    expect(moves.every((m) => !/vendor/i.test(m.location_dest_id[1]))).toBe(true);
  });

  describeErpClientContract(async () => {
    const { poId, lineId } = await freshPurchaseOrder();
    return {
      client,
      poExternalId: String(poId),
      lineExternalId: String(lineId),
      receive: (quantity) => receive(poId, lineId, quantity),
      touch: async () => {
        await transport.call("purchase.order", "write", { ids: [poId], vals: { partner_ref: `touched-${Date.now()}` } }, z.literal(true));
      },
    };
  });
});
