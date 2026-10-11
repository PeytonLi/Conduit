import { describe, expect, it } from "vitest";
import {
  BAY_CARTON,
  BUDGET_BOX,
  ITEM_A,
  ORG_A,
  harborStore,
} from "./planner-test-helpers";

describe("MemoryPlannerStore approved suppliers", () => {
  it("includes active PO suppliers once and keeps supplier/contact approvals", async () => {
    const store = harborStore();
    const poOnlySupplierId = "50000000-0000-4000-8000-000000000005";
    const cancelledSupplierId = "50000000-0000-4000-8000-000000000006";
    store.suppliers.set(poOnlySupplierId, {
      id: poOnlySupplierId,
      org_id: ORG_A,
      name: "PO-only supplier",
      purchasing_status: "approved",
    });
    store.suppliers.set(cancelledSupplierId, {
      id: cancelledSupplierId,
      org_id: ORG_A,
      name: "Cancelled PO supplier",
      purchasing_status: "approved",
    });
    store.purchaseOrders.push(
      {
        id: "90000000-0000-4000-8000-000000000001",
        org_id: ORG_A,
        supplier_id: poOnlySupplierId,
        status: "open",
      },
      {
        id: "90000000-0000-4000-8000-000000000002",
        org_id: ORG_A,
        supplier_id: BUDGET_BOX,
        status: "open",
      },
      {
        id: "90000000-0000-4000-8000-000000000003",
        org_id: ORG_A,
        supplier_id: cancelledSupplierId,
        status: "cancelled",
      },
      {
        id: "90000000-0000-4000-8000-000000000004",
        org_id: ORG_A,
        supplier_id: cancelledSupplierId,
        status: "closed",
      },
      {
        id: "90000000-0000-4000-8000-000000000005",
        org_id: ORG_A,
        supplier_id: BAY_CARTON,
        status: "open",
      },
    );
    store.purchaseOrderLines.push(
      {
        org_id: ORG_A,
        purchase_order_id: "90000000-0000-4000-8000-000000000001",
        item_id: ITEM_A,
      },
      {
        org_id: ORG_A,
        purchase_order_id: "90000000-0000-4000-8000-000000000002",
        item_id: ITEM_A,
      },
      {
        org_id: ORG_A,
        purchase_order_id: "90000000-0000-4000-8000-000000000003",
        item_id: ITEM_A,
      },
      {
        org_id: ORG_A,
        purchase_order_id: "90000000-0000-4000-8000-000000000004",
        item_id: ITEM_A,
      },
      {
        org_id: ORG_A,
        purchase_order_id: "90000000-0000-4000-8000-000000000005",
        item_id: ITEM_A,
      },
      {
        org_id: ORG_A,
        purchase_order_id: "90000000-0000-4000-8000-000000000001",
        item_id: "20000000-0000-4000-8000-000000000002",
      },
    );
    store.contacts.set("60000000-0000-4000-8000-000000000006", {
      id: "60000000-0000-4000-8000-000000000006",
      org_id: ORG_A,
      supplier_id: poOnlySupplierId,
      channel: "email",
      normalized_address: "unapproved@example.com",
      display_name: null,
      timezone: null,
      permitted_channels: ["email"],
      outreach_approved_at: null,
    });

    const suppliers = await store.listApprovedSuppliers(ORG_A, ITEM_A);

    expect(
      suppliers.filter(({ supplier }) => supplier.id === poOnlySupplierId),
    ).toHaveLength(1);
    expect(
      suppliers.find(({ supplier }) => supplier.id === poOnlySupplierId)
        ?.contacts,
    ).toEqual([]);
    expect(
      suppliers.filter(({ supplier }) => supplier.id === BAY_CARTON),
    ).toHaveLength(1);
    expect(suppliers.map(({ supplier }) => supplier.id)).not.toContain(
      BUDGET_BOX,
    );
    expect(suppliers.map(({ supplier }) => supplier.id)).not.toContain(
      cancelledSupplierId,
    );
  });
});
