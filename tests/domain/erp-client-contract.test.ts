import { describe } from "vitest";
import { describeErpClientContract } from "@/lib/integrations/business/live/contract";
import { createFakeErpClient } from "@/lib/integrations/business/live/fake";

describe("ErpClient contract (in-memory reference)", () => {
  describeErpClientContract(async () => {
    const fake = createFakeErpClient({
      snapshot: {
        as_of: new Date().toISOString(),
        locations: [{ external_id: "wh-1", name: "Main Warehouse" }],
        items: [{ external_id: "item-1", sku: "CARTON-302015", name: "Shipping carton", unit: "carton" }],
        suppliers: [{ external_id: "sup-1", name: "Bay Carton" }],
        purchase_orders: [
          {
            external_id: "PO-1",
            supplier_external_id: "sup-1",
            currency: "USD",
            status: "open",
            version: "v0",
            lines: [
              {
                external_line_id: "PO-1-1",
                item_external_id: "item-1",
                ordered_qty: 4000,
                received_qty: 0,
                unit_price_minor: "42",
                due_at: "2030-01-14T17:00:00.000Z",
                destination_external_id: "wh-1",
              },
            ],
          },
        ],
        stock: [{ item_external_id: "item-1", location_external_id: "wh-1", on_hand_qty: 600 }],
        demand: [],
      },
    });
    return {
      client: fake.client,
      poExternalId: "PO-1",
      lineExternalId: "PO-1-1",
      touch: async () => fake.touch("PO-1"),
      receive: async (q) => fake.receive("PO-1", "PO-1-1", q),
    };
  });
});
