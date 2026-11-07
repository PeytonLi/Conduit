// MOCKED: every test here runs against tests/domain/quickbooks-mock.ts, not Intuit.
import { describe, expect, it, vi } from "vitest";
import { describeErpClientContract } from "@/lib/integrations/business/live/contract";
import { ErpNotConfiguredError } from "@/lib/integrations/business/live/errors";
import { quickbooksProvider } from "@/lib/integrations/business/live/quickbooks";
import { parseMarkers, QBO_LOCATION_ID } from "@/lib/integrations/business/live/quickbooks/client";
import { qboLiteral } from "@/lib/integrations/business/live/quickbooks/http";
import { createMockQbo, seedQboCompany, type MockQbo } from "./quickbooks-mock";

const env = { QBO_CLIENT_ID: "qbo-client", QBO_CLIENT_SECRET: "qbo-secret" };
const day = (d: number) => new Date(Date.UTC(2030, 0, d, 17)).toISOString();

function credentials(qbo: MockQbo, overrides: Record<string, unknown> = {}) {
  return {
    provider: "quickbooks",
    realm_id: qbo.realmId,
    environment: "sandbox",
    refresh_token: qbo.tokens.refreshToken,
    refresh_token_expires_at: null,
    access_token: qbo.tokens.accessToken,
    access_token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides,
  };
}

function setup(saveCredentials?: (next: unknown, previous: unknown) => Promise<"saved" | "superseded">) {
  const qbo = createMockQbo();
  const company = seedQboCompany(qbo);
  const client = quickbooksProvider.createClient(credentials(qbo), { fetch: qbo.fetch, env, saveCredentials } as never);
  return { qbo, company, client };
}

type PoRow = Record<string, unknown> & {
  Id: string;
  PrivateNote?: string;
  DueDate?: string;
  Line: Array<{ Id: string; Amount: number; ItemBasedExpenseLineDetail: Record<string, unknown> & { Qty: number } }>;
};
const poRows = (qbo: MockQbo) => [...qbo.tables.PurchaseOrder.values()] as unknown as PoRow[];
const poRow = (qbo: MockQbo, id: string) => qbo.tables.PurchaseOrder.get(id) as unknown as PoRow;

describe("QuickBooks ErpClient contract (MOCKED QBO HTTP)", () => {
  describeErpClientContract(async () => {
    const { qbo, company, client } = setup();
    return {
      client,
      poExternalId: company.single.Id,
      lineExternalId: `${company.single.Id}:1`,
      touch: async () => qbo.touch(company.single.Id),
      receive: async (q) => void qbo.bill(company.single.Id, "1", q),
    };
  });
});

describe("QuickBooks ErpClient (MOCKED QBO HTTP)", () => {
  it("maps the company into a snapshot with no demand", async () => {
    const { qbo, company, client } = setup();
    qbo.bill(company.single.Id, "1", 250);
    const snapshot = await client.readSnapshot();
    expect(snapshot.locations).toEqual([{ external_id: QBO_LOCATION_ID, name: "Sandbox Company_US_1" }]);
    expect(snapshot.items.map((i) => i.sku)).toEqual(["CARTON-302015", "Packing tape"]);
    expect(snapshot.stock).toEqual([
      { item_external_id: company.item.Id, location_external_id: QBO_LOCATION_ID, on_hand_qty: 600 },
      { item_external_id: company.tape.Id, location_external_id: QBO_LOCATION_ID, on_hand_qty: 12 },
    ]);
    expect(snapshot.suppliers[0]).toMatchObject({ name: "Bay Carton Co", email: "orders@baycarton.test" });
    expect(snapshot.demand).toEqual([]);
    expect(snapshot.purchase_orders.map((p) => p.external_id)).toEqual([company.single.Id, company.multi.Id]);
    expect(snapshot.purchase_orders[0]).toEqual({
      external_id: company.single.Id,
      supplier_external_id: company.vendor.Id,
      currency: "USD",
      status: "open",
      version: "0",
      lines: [
        {
          external_line_id: `${company.single.Id}:1`,
          item_external_id: company.item.Id,
          ordered_qty: 4000,
          received_qty: 250,
          unit_price_minor: "42",
          due_at: "2030-01-14T00:00:00.000Z",
          destination_external_id: QBO_LOCATION_ID,
        },
      ],
    });
    const urls = qbo.requests.filter((r) => r.url.hostname.includes("quickbooks"));
    expect(urls.every((r) => r.url.searchParams.get("minorversion") === "75")).toBe(true);
  });

  it("splits a single-line PO into the reduced original plus a dated second PO", async () => {
    const { qbo, company, client } = setup();
    qbo.bill(company.single.Id, "1", 1000);
    const result = await client.applyDeliverySplit({
      change_ref: "act-1",
      po_external_id: company.single.Id,
      line_external_id: `${company.single.Id}:1`,
      expected_version: "0",
      schedules: [
        { quantity: 2400, earliest_at: day(17), latest_at: day(17) },
        { quantity: 600, earliest_at: day(15), latest_at: day(15) },
      ],
    });
    expect(result.status).toBe("applied");
    const original = poRow(qbo, company.single.Id);
    expect(original.Line[0].ItemBasedExpenseLineDetail.Qty).toBe(1600);
    expect(original.Line[0].Amount).toBe(672);
    expect(original.DueDate).toBe("2030-01-15");
    expect(parseMarkers(original.PrivateNote)).toEqual([{ ref: "act-1", part: 0, parts: 2, lineId: "1", base: 1000 }]);
    const second = poRows(qbo).find((p) => parseMarkers(p.PrivateNote).some((m) => m.ref === "act-1" && m.part === 1))!;
    expect(second).toMatchObject({ DueDate: "2030-01-17", POStatus: "Open", DocNumber: "1001-2", APAccountRef: { value: "33" } });
    expect(second.Line[0].ItemBasedExpenseLineDetail).toMatchObject({ Qty: 2400, UnitPrice: 0.42, ItemRef: { value: company.item.Id } });
    if (result.status === "applied") {
      expect(result.version).toBe("1");
      expect(result.deliveries).toEqual([
        { external_ref: `${company.single.Id}:1`, quantity: 600, due_at: "2030-01-15T00:00:00.000Z" },
        { external_ref: `${second.Id}:1`, quantity: 2400, due_at: "2030-01-17T00:00:00.000Z" },
      ]);
    }
    const writes = qbo.requests.filter((r) => r.method === "POST" && r.url.pathname.endsWith("/purchaseorder"));
    expect(writes).toHaveLength(2);
    expect(writes.every((w) => w.url.searchParams.get("requestid"))).toBe(true);
  });

  it("moves a line off a multi-line PO into one new PO per delivery", async () => {
    const { qbo, company, client } = setup();
    const result = await client.applyDeliverySplit({
      change_ref: "act-multi",
      po_external_id: company.multi.Id,
      line_external_id: `${company.multi.Id}:1`,
      expected_version: "0",
      schedules: [
        { quantity: 30, earliest_at: day(16), latest_at: day(16) },
        { quantity: 70, earliest_at: day(20), latest_at: day(20) },
      ],
    });
    expect(result.status).toBe("applied");
    const original = poRow(qbo, company.multi.Id);
    expect(original.Line.map((l) => l.Id)).toEqual(["2"]);
    expect(original.DueDate).toBe("2030-01-15");
    const parts = poRows(qbo).filter((p) => p.Id !== company.multi.Id && parseMarkers(p.PrivateNote).some((m) => m.ref === "act-multi"));
    expect(parts.map((p) => [p.DueDate, p.Line[0].ItemBasedExpenseLineDetail.Qty])).toEqual([
      ["2030-01-16", 30],
      ["2030-01-20", 70],
    ]);
  });

  it("returns conflict when QBO rejects a stale SyncToken mid-write", async () => {
    const { qbo, company, client } = setup();
    qbo.hooks.beforeWrite = () => {
      qbo.hooks.beforeWrite = undefined;
      qbo.touch(company.single.Id);
    };
    const result = await client.applyDeliverySplit({
      change_ref: "act-race",
      po_external_id: company.single.Id,
      line_external_id: `${company.single.Id}:1`,
      expected_version: "0",
      schedules: [{ quantity: 4000, earliest_at: day(15), latest_at: day(15) }],
    });
    expect(result).toEqual({ status: "conflict", current_version: "1", message: "QuickBooks rejected a stale SyncToken" });
    expect(poRows(qbo)).toHaveLength(3);
  });

  it("reports unknown after a lost response and finishes on retry without duplicates", async () => {
    const { qbo, company, client } = setup();
    qbo.hooks.failAfterWrite = (entity, body) => entity === "PurchaseOrder" && !body.Id;
    const request = {
      change_ref: "act-lost",
      po_external_id: company.single.Id,
      line_external_id: `${company.single.Id}:1`,
      expected_version: "0",
      schedules: [
        { quantity: 1000, earliest_at: day(15), latest_at: day(15) },
        { quantity: 3000, earliest_at: day(18), latest_at: day(18) },
      ],
    };
    expect((await client.applyDeliverySplit(request)).status).toBe("unknown");
    qbo.hooks.failAfterWrite = undefined;
    const retry = await client.applyDeliverySplit({ ...request, expected_version: "1" });
    expect(retry.status).toBe("applied");
    expect(poRows(qbo).filter((p) => parseMarkers(p.PrivateNote).some((m) => m.ref === "act-lost"))).toHaveLength(2);
    const again = await client.applyDeliverySplit({ ...request, expected_version: "1" });
    expect(again.status).toBe("applied");
    expect(poRows(qbo)).toHaveLength(4);
  });

  it("does not report a half-finished change as applied", async () => {
    const { qbo, company, client } = setup();
    qbo.hooks.beforeWrite = (_entity, body) => {
      if (!body.Id) throw new TypeError("fetch failed");
    };
    const result = await client.applyDeliverySplit({
      change_ref: "act-half",
      po_external_id: company.single.Id,
      line_external_id: `${company.single.Id}:1`,
      expected_version: "0",
      schedules: [
        { quantity: 1000, earliest_at: day(15), latest_at: day(15) },
        { quantity: 3000, earliest_at: day(18), latest_at: day(18) },
      ],
    });
    expect(result.status).toBe("unknown");
    expect(await client.findChange("act-half", company.single.Id)).toEqual({ status: "not_found" });
  });

  it("rejects schedules that do not cover the open quantity, closed POs and bad refs", async () => {
    const { company, client } = setup();
    const base = { po_external_id: company.single.Id, line_external_id: `${company.single.Id}:1`, expected_version: "0" };
    const one = (quantity: number) => [{ quantity, earliest_at: day(15), latest_at: day(15) }];
    expect(await client.applyDeliverySplit({ ...base, change_ref: "a", schedules: one(10) })).toMatchObject({ status: "rejected", code: "quantity_mismatch" });
    expect(await client.applyDeliverySplit({ ...base, change_ref: "a b", schedules: one(4000) })).toMatchObject({ status: "rejected", code: "invalid_change_ref" });
    expect(await client.applyDeliverySplit({ ...base, change_ref: "a", schedules: one(1.5) })).toMatchObject({ status: "rejected", code: "invalid_schedule" });
    expect(
      await client.applyDeliverySplit({ ...base, change_ref: "a", po_external_id: company.closed.Id, line_external_id: `${company.closed.Id}:1`, schedules: one(10) }),
    ).toMatchObject({ status: "rejected", code: "closed" });
    expect(await client.applyDeliverySplit({ ...base, change_ref: "a", po_external_id: "999", schedules: one(10) })).toMatchObject({ status: "rejected", code: "not_found" });
    expect(await client.readPurchaseOrder("999")).toBeNull();
  });

  it("derives receipts from bill lines linked to PO lines", async () => {
    const { qbo, company, client } = setup();
    const bill = qbo.bill(company.single.Id, "1", 40);
    const receipts = await client.listReceipts(new Date(Date.now() - 60_000).toISOString());
    expect(receipts).toEqual([
      {
        external_receipt_id: `bill:${bill.Id}:1`,
        po_external_id: company.single.Id,
        line_external_id: `${company.single.Id}:1`,
        quantity: 40,
        received_at: expect.any(String),
        kind: "received",
      },
    ]);
    expect(await client.listReceipts(new Date(Date.now() + 60_000).toISOString())).toEqual([]);
  });
});

describe("QuickBooks tokens and setup (MOCKED)", () => {
  it("refreshes an expired access token and saves the rotated refresh token", async () => {
    const qbo = createMockQbo();
    seedQboCompany(qbo);
    const save = vi.fn(async () => "saved" as const);
    const client = quickbooksProvider.createClient(credentials(qbo, { access_token: null, access_token_expires_at: null }), {
      fetch: qbo.fetch,
      env,
      saveCredentials: save,
    } as never);
    await client.readSnapshot();
    expect(save).toHaveBeenCalledTimes(1);
    const [next, previous] = save.mock.calls[0] as unknown as [Record<string, unknown>, Record<string, unknown>];
    expect(previous.refresh_token).toBe("refresh-0");
    expect(next).toMatchObject({ refresh_token: "refresh-1", access_token: "access-1", realm_id: qbo.realmId });
    expect(next.refresh_token_expires_at).toEqual(expect.any(String));
  });

  it("retries once with a fresh token after a 401", async () => {
    const qbo = createMockQbo();
    seedQboCompany(qbo);
    const client = quickbooksProvider.createClient(credentials(qbo, { access_token: "revoked" }), { fetch: qbo.fetch, env } as never);
    expect((await client.readSnapshot()).purchase_orders).toHaveLength(2);
    expect(qbo.tokens.refreshToken).toBe("refresh-1");
  });

  it("is not configured without client credentials and rejects bad stored credentials", () => {
    const qbo = createMockQbo();
    expect(() => quickbooksProvider.createClient(credentials(qbo), { env: {} } as never)).toThrow(ErpNotConfiguredError);
    expect(() => quickbooksProvider.createClient({ provider: "quickbooks" }, { env } as never)).toThrow();
  });

  it("quotes query literals", () => {
    expect(qboLiteral("O'Brien \\ Co")).toBe("'O\\'Brien \\\\ Co'");
  });
});
