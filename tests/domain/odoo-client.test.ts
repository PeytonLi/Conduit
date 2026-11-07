import { describe, expect, it, vi } from "vitest";
import {
  createOdooErpClient,
  createOdooTransport,
  odooProvider,
  odooUrlAllowed,
  OdooRpcError,
  OdooTransportError,
  verifyOdooConnection,
} from "@/lib/integrations/business/live/odoo";
import { changeStamp, OdooDataError, parseChangeStamp } from "@/lib/integrations/business/live/odoo/client";

// Mocked HTTP only: a canned JSON-2 Odoo, no real system. The real-Odoo run is
// tests/integration/odoo-contract.test.ts behind ODOO_CONTRACT_URL.
const credentials = { url: "https://acme.odoo.example", database: "acme", username: "planner@acme.example", api_key: "k".repeat(40) };

type Body = Record<string, unknown> & { domain?: unknown[][]; ids?: number[]; vals?: Record<string, unknown> };
type Handler = (body: Body) => unknown;
interface Call { key: string; body: Body; headers: Record<string, string> }

function mockOdoo(handlers: Record<string, Handler>, version: unknown = { version_info: [20, 0, 0, "final", 0, ""], version: "20.0" }) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/web/version") return Response.json(version);
    const key = url.pathname.replace("/json/2/", "");
    const body = JSON.parse(String(init?.body ?? "{}")) as Body;
    calls.push({ key, body, headers: init?.headers as Record<string, string> });
    const handler = handlers[key];
    if (!handler) return Response.json({ name: "odoo.exceptions.MissingError", message: `no handler for ${key}` }, { status: 404 });
    const result = handler(body);
    return result instanceof Response ? result : Response.json(result);
  });
  return { fetch: fetchMock as unknown as typeof fetch, calls, writes: () => calls.filter((c) => c.key === "purchase.order/write") };
}

function purchaseOrderOdoo(overrides: { lineQty?: number; write?: Handler } = {}) {
  const state = {
    po: { id: 7, name: "P00007", partner_id: [3, "Bay Carton Supply"], currency_id: [1, "USD"], state: "purchase", locked: false, partner_ref: false, picking_type_id: [1, "Receipts"], write_date: "2030-01-01 10:00:00", order_line: [11] },
    lines: [{ id: 11, order_id: [7, "P00007"], product_id: [5, "Carton"], product_qty: overrides.lineQty ?? 4000, product_uom_qty: overrides.lineQty ?? 4000, qty_received: 0, price_unit: 0.42, date_planned: "2030-01-14 17:00:00", display_type: false, write_date: "2030-01-01 10:00:00" }] as Record<string, unknown>[],
    messages: [] as { id: number; body: string }[],
  };
  const handlers: Record<string, Handler> = {
    "purchase.order/search_read": () => [state.po],
    "purchase.order.line/search_read": () => state.lines,
    "res.currency/search_read": () => [{ id: 1, name: "USD", decimal_places: 2 }],
    "stock.picking.type/search_read": () => [{ id: 1, warehouse_id: [1, "WH"] }],
    "mail.message/search_read": (body) => {
      const term = String((body.domain ?? []).find((d) => d[0] === "body")?.[2] ?? "");
      return state.messages.filter((m) => m.body.includes(term));
    },
    "stock.move/search_read": () => [{ id: 80, product_uom_qty: 4000 }],
    "ir.model.data/check_object_reference": () => ["mail.message.subtype", 2],
    "purchase.order.line/copy_data": () => [{ product_id: 5, order_id: 7, product_qty: 4000, price_unit: 0.42, date_planned: "2030-01-14 17:00:00", date_promised: "2030-01-14 17:00:00" }],
    "purchase.order/write": overrides.write ?? ((body) => {
      const vals = body.vals as { order_line: [number, number, Record<string, unknown>][]; message_ids: [number, number, { body: string }][] };
      for (const [op, id, v] of vals.order_line) {
        if (op === 1) Object.assign(state.lines.find((l) => l.id === id)!, { product_qty: v.product_qty, product_uom_qty: v.product_qty, date_planned: v.date_planned, write_date: "2030-01-01 10:00:05" });
        if (op === 0) state.lines.push({ ...state.lines[0], id: 12, product_qty: v.product_qty, product_uom_qty: v.product_qty, date_planned: v.date_planned, write_date: "2030-01-01 10:00:05" });
      }
      state.po.order_line = state.lines.map((l) => l.id as number);
      state.po.write_date = "2030-01-01 10:00:05";
      state.messages.push({ id: 900, body: `<p>${vals.message_ids[0][2].body}</p>` });
      return true;
    }),
  };
  return { state, handlers };
}

const splitOf = (version: string, ref = "act_123") => ({
  change_ref: ref,
  po_external_id: "7",
  line_external_id: "11",
  expected_version: version,
  schedules: [
    { quantity: 600, earliest_at: "2030-01-15T17:00:00Z", latest_at: "2030-01-15T17:00:00Z" },
    { quantity: 3400, earliest_at: "2030-01-17T17:00:00Z", latest_at: "2030-01-17T17:00:00Z" },
  ],
});

describe("Odoo JSON-2 transport (mocked HTTP)", () => {
  it("posts to /json/2/<model>/<method> with the bearer key and database header", async () => {
    const odoo = mockOdoo({ "res.partner/search_count": () => 4 });
    const transport = createOdooTransport(credentials, { fetch: odoo.fetch });
    const { z } = await import("zod");
    await expect(transport.call("res.partner", "search_count", { domain: [] }, z.number())).resolves.toBe(4);
    expect(odoo.calls[0].headers).toMatchObject({ Authorization: `bearer ${credentials.api_key}`, "X-Odoo-Database": "acme" });
  });

  it("treats 4xx as an Odoo error and 5xx or network failure as unknown", async () => {
    const { z } = await import("zod");
    const statuses = [404, 503];
    for (const status of statuses) {
      const transport = createOdooTransport(credentials, {
        fetch: (async () => Response.json({ name: "odoo.exceptions.UserError", message: "nope" }, { status })) as typeof fetch,
      });
      await expect(transport.call("a", "b", {}, z.unknown())).rejects.toBeInstanceOf(status === 404 ? OdooRpcError : OdooTransportError);
    }
    const offline = createOdooTransport(credentials, { fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch });
    await expect(offline.call("a", "b", {}, z.unknown())).rejects.toBeInstanceOf(OdooTransportError);
  });
});

describe("Odoo ErpClient (mocked HTTP)", () => {
  it("maps a purchase order with integer quantities, minor-unit prices and ISO dates", async () => {
    const { handlers } = purchaseOrderOdoo();
    const client = createOdooErpClient(createOdooTransport(credentials, { fetch: mockOdoo(handlers).fetch }));
    const po = await client.readPurchaseOrder("7");
    expect(po).toMatchObject({
      external_id: "7",
      supplier_external_id: "3",
      currency: "USD",
      status: "purchase",
      lines: [{ external_line_id: "11", item_external_id: "5", ordered_qty: 4000, received_qty: 0, unit_price_minor: "42", due_at: "2030-01-14T17:00:00.000Z", destination_external_id: "1" }],
    });
    expect(po!.version).toMatch(/^2030-01-01T10:00:00Z~[0-9a-f]{16}$/);
  });

  it("moves the version when a field changes within the same second", async () => {
    const { state, handlers } = purchaseOrderOdoo();
    const client = createOdooErpClient(createOdooTransport(credentials, { fetch: mockOdoo(handlers).fetch }));
    const before = (await client.readPurchaseOrder("7"))!.version;
    state.po.partner_ref = "changed" as never;
    expect((await client.readPurchaseOrder("7"))!.version).not.toBe(before);
  });

  it("refuses fractional quantities instead of rounding them", async () => {
    const { handlers } = purchaseOrderOdoo({ lineQty: 12.5 });
    const client = createOdooErpClient(createOdooTransport(credentials, { fetch: mockOdoo(handlers).fetch }));
    await expect(client.readPurchaseOrder("7")).rejects.toBeInstanceOf(OdooDataError);
  });

  it("returns conflict without writing when the version is stale", async () => {
    const { handlers } = purchaseOrderOdoo();
    const odoo = mockOdoo(handlers);
    const client = createOdooErpClient(createOdooTransport(credentials, { fetch: odoo.fetch }));
    const result = await client.applyDeliverySplit(splitOf("2029-12-31T00:00:00Z~0000000000000000"));
    expect(result.status).toBe("conflict");
    expect(odoo.writes()).toHaveLength(0);
  });

  it("splits in one write: shrinks the line and its receipt move, adds a dated line, stamps the ref", async () => {
    const { handlers } = purchaseOrderOdoo();
    const odoo = mockOdoo(handlers);
    const client = createOdooErpClient(createOdooTransport(credentials, { fetch: odoo.fetch }));
    const version = (await client.readPurchaseOrder("7"))!.version;
    const result = await client.applyDeliverySplit(splitOf(version));
    expect(result).toMatchObject({
      status: "applied",
      provider_ref: "odoo:purchase.order/7#mail.message/900",
      deliveries: [
        { external_ref: "11", quantity: 600, due_at: "2030-01-15T17:00:00.000Z" },
        { external_ref: "12", quantity: 3400, due_at: "2030-01-17T17:00:00.000Z" },
      ],
    });
    const [write] = odoo.writes();
    const vals = write.body.vals as { order_line: unknown[]; message_ids: [number, number, { body: string; model: string }][] };
    expect(write.body.ids).toEqual([7]);
    expect(vals.order_line).toEqual([
      [1, 11, { product_qty: 600, date_planned: "2030-01-15 17:00:00", move_ids: [[1, 80, { product_uom_qty: 600 }]] }],
      [0, 0, { product_id: 5, product_qty: 3400, price_unit: 0.42, date_planned: "2030-01-17 17:00:00", date_promised: "2030-01-17 17:00:00" }],
    ]);
    expect(vals.message_ids[0][2]).toMatchObject({ model: "purchase.order" });
    expect(vals.message_ids[0][2].body).toContain("[conduit-split ref=act_123 line=11 plan=600@2030-01-15T17:00:00.000Z,3400@2030-01-17T17:00:00.000Z]");

    const retry = await client.applyDeliverySplit({ ...splitOf(version), expected_version: result.status === "applied" ? result.version : "" });
    expect(retry.status).toBe("applied");
    expect(odoo.writes()).toHaveLength(1);
  });

  it("reports unknown when the write gets no usable answer, rejected when Odoo refuses it", async () => {
    for (const [status, expected] of [[502, "unknown"], [422, "rejected"]] as const) {
      const { handlers } = purchaseOrderOdoo({ write: () => Response.json({ name: "odoo.exceptions.UserError", message: "blocked" }, { status }) });
      const client = createOdooErpClient(createOdooTransport(credentials, { fetch: mockOdoo(handlers).fetch }));
      const version = (await client.readPurchaseOrder("7"))!.version;
      const result = await client.applyDeliverySplit(splitOf(version));
      expect(result.status).toBe(expected);
      if (result.status === "rejected") expect(result.code).toBe("odoo_usererror");
    }
  });

  it("rejects schedules that do not cover the open quantity", async () => {
    const { handlers } = purchaseOrderOdoo();
    const odoo = mockOdoo(handlers);
    const client = createOdooErpClient(createOdooTransport(credentials, { fetch: odoo.fetch }));
    const version = (await client.readPurchaseOrder("7"))!.version;
    const request = splitOf(version);
    request.schedules[1].quantity = 3000;
    expect(await client.applyDeliverySplit(request)).toMatchObject({ status: "rejected", code: "quantity_mismatch" });
    expect(odoo.writes()).toHaveLength(0);
  });

  it("finds nothing for a ref it never stamped", async () => {
    const { handlers } = purchaseOrderOdoo();
    const client = createOdooErpClient(createOdooTransport(credentials, { fetch: mockOdoo(handlers).fetch }));
    expect(await client.findChange("act_missing", "7")).toEqual({ status: "not_found" });
  });

  it("lists receipts and vendor returns from done stock moves", async () => {
    const odoo = mockOdoo({
      "stock.move/search_read": (body) =>
        JSON.stringify(body.domain).includes('"!=","supplier"')
          ? [{ id: 31, purchase_line_id: [11, false], quantity: 600, date: "2030-01-15 18:00:00", origin_returned_move_id: false }]
          : [{ id: 32, purchase_line_id: [11, false], quantity: 20, date: "2030-01-16 09:00:00", origin_returned_move_id: [31, false] }],
      "purchase.order.line/search_read": () => [{ id: 11, order_id: [7, "P00007"] }],
    });
    const client = createOdooErpClient(createOdooTransport(credentials, { fetch: odoo.fetch }));
    expect(await client.listReceipts("2030-01-15T00:00:00.000Z")).toEqual([
      { external_receipt_id: "stock.move/31", po_external_id: "7", line_external_id: "11", quantity: 600, received_at: "2030-01-15T18:00:00.000Z", kind: "received" },
      { external_receipt_id: "stock.move/32", po_external_id: "7", line_external_id: "11", quantity: 20, received_at: "2030-01-16T09:00:00.000Z", kind: "reversal", reverses_external_id: "stock.move/31" },
    ]);
    expect(JSON.stringify(odoo.calls[0].body.domain)).toContain('["date",">=","2030-01-15 00:00:00"]');
  });

  it("builds a snapshot with on-hand per warehouse and dated outgoing demand", async () => {
    const { handlers } = purchaseOrderOdoo();
    const odoo = mockOdoo({
      ...handlers,
      "stock.move/search_read": () => [
        { id: 41, product_id: [5, "Carton"], product_qty: 400, date: "2030-01-14 17:00:00", location_id: [8, "WH/Stock"] },
        { id: 42, product_id: [5, "Carton"], product_qty: 400, date: "2030-01-15 17:00:00", location_id: [8, "WH/Stock"] },
      ],
      "stock.warehouse/search_read": () => [{ id: 1, name: "Main Warehouse" }],
      "product.product/search_read": () => [{ id: 5, default_code: "CARTON-302015", name: "Shipping carton", uom_id: [1, "Units"] }],
      "stock.quant/search_read": () => [
        { id: 1, product_id: [5, "Carton"], warehouse_id: [1, "WH"], quantity: 550 },
        { id: 2, product_id: [5, "Carton"], warehouse_id: [1, "WH"], quantity: 50 },
      ],
      "res.partner/search_read": () => [{ id: 3, name: "Bay Carton Supply", email: "orders@baycarton.example", phone: false }],
      "stock.location/search_read": () => [{ id: 8, warehouse_id: [1, "WH"] }],
    });
    const client = createOdooErpClient(createOdooTransport(credentials, { fetch: odoo.fetch }), { now: () => new Date("2030-01-13T12:00:00Z") });
    const snapshot = await client.readSnapshot();
    expect(snapshot.as_of).toBe("2030-01-13T12:00:00.000Z");
    expect(snapshot.stock).toEqual([{ item_external_id: "5", location_external_id: "1", on_hand_qty: 600 }]);
    expect(snapshot.demand.map((d) => [d.quantity, d.required_at, d.location_external_id])).toEqual([
      [400, "2030-01-14T17:00:00.000Z", "1"],
      [400, "2030-01-15T17:00:00.000Z", "1"],
    ]);
    expect(snapshot.items).toEqual([{ external_id: "5", sku: "CARTON-302015", name: "Shipping carton", unit: "Units" }]);
    expect(snapshot.suppliers).toEqual([{ external_id: "3", name: "Bay Carton Supply", email: "orders@baycarton.example", phone: null }]);
  });
});

describe("Odoo change stamp", () => {
  it("round-trips and does not match a different ref with the same prefix", () => {
    const body = `<p>${changeStamp("act_1", 11, [{ quantity: 600, due_at: "2030-01-15T17:00:00.000Z" }])}</p>`;
    expect(parseChangeStamp(body, "act_1")).toEqual({ lineId: 11, plan: [{ quantity: 600, due_at: "2030-01-15T17:00:00.000Z" }] });
    expect(parseChangeStamp(body, "act_")).toBeNull();
    expect(parseChangeStamp(body, "act_10")).toBeNull();
  });
});

describe("Odoo connection checks (mocked HTTP)", () => {
  const ok = {
    "res.users/context_get": () => ({ uid: 2, lang: "en_US" }),
    "res.users/read": () => [{ id: 2, login: "planner@acme.example" }],
    "purchase.order/search_count": () => 1,
    "purchase.order.line/search_count": () => 1,
    "stock.quant/search_count": () => 1,
    "stock.move/search_count": () => 1,
  };

  it("accepts a matching login with read access", async () => {
    expect(await verifyOdooConnection(credentials, { fetch: mockOdoo(ok).fetch })).toEqual({
      ok: true,
      externalAccountId: "acme.odoo.example/acme",
      serverVersion: "20.0",
      userId: 2,
    });
  });

  it("names the problem for old versions, bad keys and another user's key", async () => {
    const old = mockOdoo(ok, { version_info: [18, 0, 0, "final", 0, ""], version: "18.0" });
    expect(await verifyOdooConnection(credentials, { fetch: old.fetch })).toMatchObject({ ok: false, code: "unsupported_version" });
    const denied = mockOdoo({ ...ok, "res.users/context_get": () => Response.json({ name: "werkzeug.exceptions.Unauthorized", message: "Invalid apikey" }, { status: 401 }) });
    expect(await verifyOdooConnection(credentials, { fetch: denied.fetch })).toMatchObject({ ok: false, code: "invalid_credentials" });
    const other = mockOdoo({ ...ok, "res.users/read": () => [{ id: 2, login: "someone@acme.example" }] });
    expect(await verifyOdooConnection(credentials, { fetch: other.fetch })).toMatchObject({ ok: false, code: "login_mismatch" });
  });

  it("only allows public https addresses in production", () => {
    expect(odooUrlAllowed("https://acme.odoo.com", true)).toBe(true);
    for (const url of ["http://acme.odoo.com", "https://localhost:8069", "https://10.0.0.5", "https://169.254.169.254", `https://${["u", "p"].join(":")}@acme.odoo.com`]) {
      expect(odooUrlAllowed(url, true)).toBe(false);
    }
    expect(odooUrlAllowed("http://127.0.0.1:8069", false)).toBe(true);
  });

  it("odooProvider builds a client and refuses malformed credentials", () => {
    expect(odooProvider.createClient(credentials).provider).toBe("odoo");
    expect(() => odooProvider.createClient({ url: "not a url" })).toThrow();
  });
});
