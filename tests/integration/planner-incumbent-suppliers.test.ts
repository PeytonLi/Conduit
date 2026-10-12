import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SupabasePlannerStore } from "@/lib/agent/store-supabase";
import { createInboxOrg, pgClient, type InboxOrg } from "./inbox-helpers";

vi.mock("server-only", () => ({}));

let database: Client | null = null;
let org: InboxOrg | null = null;
let itemId: string | null = null;
let supplierId: string | null = null;
let store: SupabasePlannerStore | null = null;

function configureLocalSupabase(): void {
  const output = execFileSync("pnpm", ["exec", "supabase", "status", "-o", "env"], {
    encoding: "utf8",
  });
  const values = Object.fromEntries(
    output
      .split(/\r?\n/)
      .map((line) => line.match(/^([A-Z_]+)="?(.*?)"?$/))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .map((match) => [match[1], match[2]]),
  );
  const url = values.API_URL ?? values.SUPABASE_URL;
  const secretKey = values.SERVICE_ROLE_KEY ?? values.SUPABASE_SECRET_KEY;
  if (!url || !secretKey) {
    throw new Error("Local Supabase service credentials are unavailable");
  }
  store = new SupabasePlannerStore(
    createClient(url, secretKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    }),
  );
}

beforeAll(async () => {
  configureLocalSupabase();
  const db = pgClient();
  database = db;
  await db.connect();
  org = await createInboxOrg(db, `planner-supplier-${randomUUID().slice(0, 8)}`);
  itemId = randomUUID();
  supplierId = randomUUID();
  const purchaseOrderId = randomUUID();
  await db.query(
    `insert into public.items (id, org_id, sku, description, base_unit)
     values ($1, $2, $3, 'Incumbent test item', 'each')`,
    [itemId, org.orgId, `SKU-${itemId.slice(0, 8)}`],
  );
  await db.query(
    `insert into public.suppliers (id, org_id, name, purchasing_status)
     values ($1, $2, 'PO incumbent', 'approved')`,
    [supplierId, org.orgId],
  );
  await db.query(
    `insert into public.purchase_orders (id, org_id, external_id, supplier_id, currency, status)
     values ($1, $2, $3, $4, 'USD', 'open')`,
    [purchaseOrderId, org.orgId, `PO-${purchaseOrderId.slice(0, 8)}`, supplierId],
  );
  await db.query(
    `insert into public.purchase_order_lines
       (id, org_id, purchase_order_id, item_id, destination_location_id,
        ordered_qty, unit_price_minor)
     values ($1, $2, $3, $4, $5, 10, 100)`,
    [randomUUID(), org.orgId, purchaseOrderId, itemId, org.locationId],
  );
});

afterAll(async () => {
  if (!database) return;
  try {
    if (org) {
      await database.query("delete from public.organizations where id = $1", [
        org.orgId,
      ]);
    }
  } finally {
    await database.end();
  }
});

describe("SupabasePlannerStore incumbent suppliers", () => {
  it("lists an approved supplier from an active PO without a supplier-item link", async () => {
    if (!database || !org || !itemId || !supplierId || !store) {
      throw new Error("PO supplier fixture was not initialized");
    }
    const linkCount = await database.query(
      `select count(*)::int as count from public.supplier_items
       where org_id = $1 and item_id = $2 and supplier_id = $3`,
      [org.orgId, itemId, supplierId],
    );
    expect(linkCount.rows[0].count).toBe(0);

    const suppliers = await store.listApprovedSuppliers(org.orgId, itemId);

    expect(suppliers.map(({ supplier }) => supplier.id)).toContain(supplierId);
  });
});
