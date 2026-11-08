import { describe, expect, it } from "vitest";
import { mulQtyPrice } from "@/lib/domain/money";
import { projectInventory } from "@/lib/domain/inventory";
import { validateImport } from "@/lib/domain/import-validate";
import { maxSafeTransferQuantity } from "@/lib/domain/transfers";
import { parseQuantity, quantitiesEqual } from "@/lib/domain/quantity";
import { baseProjection } from "./domain-test-helpers";

describe("P2 fractional quantities", () => {
  it("parses bounded-scale decimals and rejects over-precision", () => {
    expect(parseQuantity("1.5", 3)).toEqual({ ok: true, value: 1.5 });
    expect(parseQuantity("1.234567", 3)).toEqual({ ok: false, code: "extra_precision" });
    expect(parseQuantity("1.5", 0)).toEqual({ ok: false, code: "not_number" });
  });

  it("computes money with half-up minor-unit rounding for fractional qty", () => {
    expect(mulQtyPrice(1.5, 40n)).toBe(60n);
    expect(mulQtyPrice(0.333, 100n, 3)).toBe(33n);
    expect(mulQtyPrice(0.335, 100n, 3)).toBe(34n);
    expect(mulQtyPrice(600, 35n)).toBe(21_000n);
  });

  it("projects shortage with fractional demand and receipts", () => {
    const result = projectInventory(baseProjection({
      physicalQty: 10.5,
      demand: [
        {
          id: "d1",
          quantity: 8.25,
          requiredAt: "2026-10-13T16:00:00Z",
          certainty: "confirmed",
          includedReservedQty: 0,
        },
        {
          id: "d2",
          quantity: 4.5,
          requiredAt: "2026-10-14T16:00:00Z",
          certainty: "confirmed",
          includedReservedQty: 0,
        },
      ],
      receipts: [],
    }));
    expect(result.quality).toBe("sufficient");
    expect(result.bridgeQuantity).toBe(2.25);
    expect(result.firstShortageAt).toBe("2026-10-14T16:00:00Z");
  });

  it("binary-searches max safe transfer with fractional stock", () => {
    const source = baseProjection({
      physicalQty: 10.5,
      demand: [
        {
          id: "d1",
          quantity: 8,
          requiredAt: "2026-10-13T16:00:00Z",
          certainty: "confirmed",
          includedReservedQty: 0,
        },
      ],
    });
    const max = maxSafeTransferQuantity(source);
    expect(max).toBe(2.5);
    expect(quantitiesEqual(max + 8, 10.5)).toBe(true);
  });

  it("accepts fractional import rows for kg items and rejects fractions on cartons", () => {
    const files: Record<string, string> = {
      "suppliers.csv": "supplier_id,name,purchasing_status,contact_name,email,phone,contact_timezone,outreach_approved\nS1,Supply,approved,A,a@example.com,,America/Los_Angeles,true\n",
      "items.csv": "item_id,sku,description,base_unit,length_mm,width_mm,height_mm,material_grade\nC1,BOX,Carton,carton,1,1,1,G\nK1,TAPE,Tape,kg,1,1,1,G\n",
      "purchase_orders.csv": "po_id,supplier_id,currency,status\nPO1,S1,USD,open\n",
      "purchase_order_lines.csv": "po_id,line_id,item_id,location_id,ordered_qty,received_qty,cancelled_qty,unit_price_minor,original_due_at\nPO1,L1,C1,WH,10,0,0,100,\nPO1,L2,K1,WH,10.5,0,0,100,\n",
      "receipt_schedules.csv": "receipt_id,po_id,line_id,quantity_remaining,earliest_at,latest_at,promise_state,source_reference\nR1,PO1,L1,10,,,confirmed,src\nR2,PO1,L2,10.5,,,confirmed,src\n",
      "inventory.csv": "item_id,location_id,physical_qty,unusable_qty,outside_allocations_qty,source_as_of\nC1,WH,10,0,0,2026-10-10T12:00:00Z\nK1,WH,10.5,0,0,2026-10-10T12:00:00Z\n",
      "demand.csv": "demand_id,item_id,location_id,remaining_qty,required_at,certainty,included_reserved_qty,source_as_of\nD1,K1,WH,2.5,2026-10-15T12:00:00Z,confirmed,0,2026-10-10T12:00:00Z\n",
    };
    const ok = validateImport({
      files,
      metadata: { schema_version: 1, source_as_of: "2026-10-10T12:00:00Z", timezone: "America/Los_Angeles", currency: "USD" },
      orgCurrency: "USD",
      knownLocations: [{ id: "loc", externalId: "WH", timezone: "America/Los_Angeles" }],
      now: "2026-10-10T12:00:00Z",
    });
    expect(ok.ok).toBe(true);
    expect(ok.payload?.items.find((i) => i.external_id === "K1")?.quantity_scale).toBe(3);

    const bad = { ...files };
    bad["inventory.csv"] = bad["inventory.csv"].replace("C1,WH,10,", "C1,WH,1.5,");
    const cartonFrac = validateImport({
      files: bad,
      metadata: { schema_version: 1, source_as_of: "2026-10-10T12:00:00Z", timezone: "America/Los_Angeles", currency: "USD" },
      orgCurrency: "USD",
      knownLocations: [{ id: "loc", externalId: "WH", timezone: "America/Los_Angeles" }],
      now: "2026-10-10T12:00:00Z",
    });
    expect(cartonFrac.ok).toBe(false);
    expect(cartonFrac.errors).toContainEqual(expect.objectContaining({ field: "physical_qty", code: "not_integer" }));
  });
});
