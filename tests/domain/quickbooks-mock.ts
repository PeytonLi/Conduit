/**
 * MOCKED QuickBooks Online: an in-memory stand-in for the Accounting API and Intuit's token
 * endpoint, shaped after the documented JSON. Nothing here talks to Intuit.
 */
type Row = Record<string, unknown> & { Id: string };

const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

export interface MockQboOptions {
  realmId?: string;
  clientId?: string;
  clientSecret?: string;
  now?: () => Date;
}

export function createMockQbo(options: MockQboOptions = {}) {
  const realmId = options.realmId ?? "9341453000000000";
  const clientId = options.clientId ?? "qbo-client";
  const clientSecret = options.clientSecret ?? "qbo-secret";
  const now = options.now ?? (() => new Date());
  const tables: Record<string, Map<string, Row>> = {
    PurchaseOrder: new Map(),
    Bill: new Map(),
    Item: new Map(),
    Vendor: new Map(),
    CompanyInfo: new Map([[realmId, { Id: realmId, CompanyName: "Sandbox Company_US_1", Country: "US" }]]),
  };
  const requestIds = new Map<string, unknown>();
  let nextId = 200;
  let refreshCount = 0;
  const state = { accessToken: "access-0", refreshToken: "refresh-0" };
  const requests: { method: string; url: URL; body: unknown }[] = [];
  const hooks: { beforeWrite?: (entity: string, body: Row) => void; failAfterWrite?: (entity: string, body: Row) => boolean } = {};

  const stamp = () => now().toISOString().replace(/\.\d{3}Z$/, "-00:00");
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fault = (status: number, code: string, message: string, type = "ValidationFault") =>
    json(status, { Fault: { Error: [{ Message: message, Detail: message, code }], type }, time: stamp() });

  function insert(entity: string, body: Record<string, unknown>): Row {
    const id = String(nextId++);
    const t = stamp();
    const lines = ((body.Line as Row[] | undefined) ?? []).map((l, i) => ({ ...l, Id: String(i + 1), LineNum: i + 1 }));
    const row: Row = { ...body, Id: id, SyncToken: "0", Line: lines, MetaData: { CreateTime: t, LastUpdatedTime: t } };
    tables[entity].set(id, row);
    return row;
  }

  function update(entity: string, body: Record<string, unknown>): Row | Response {
    const current = tables[entity].get(String(body.Id));
    if (!current) return fault(400, "610", "Object Not Found");
    if (body.SyncToken !== current.SyncToken) {
      return fault(400, "5010", "Stale Object Error : You and someone else have edited the same entity");
    }
    const { sparse, ...rest } = body;
    const base = sparse ? current : { Id: current.Id, MetaData: current.MetaData };
    let lineId = Math.max(0, ...((current.Line as Row[]) ?? []).map((l) => Number(l.Id)));
    const lines = ((rest.Line as Row[] | undefined) ?? (current.Line as Row[])).map((l) => (l.Id ? l : { ...l, Id: String(++lineId) }));
    const row: Row = {
      ...base,
      ...rest,
      Id: current.Id,
      Line: lines,
      SyncToken: String(Number(current.SyncToken) + 1),
      MetaData: { ...(current.MetaData as object), LastUpdatedTime: stamp() },
    };
    tables[entity].set(row.Id, row);
    return row;
  }

  function linkBill(bill: Row) {
    for (const line of (bill.Line as Row[]) ?? []) {
      for (const link of (line.LinkedTxn as Row[] | undefined) ?? []) {
        const po = tables.PurchaseOrder.get(String(link.TxnId));
        if (!po) continue;
        const linked = ((po.LinkedTxn as Row[] | undefined) ?? []).filter((t) => t.TxnId !== bill.Id);
        po.LinkedTxn = [...linked, { TxnId: bill.Id, TxnType: "Bill" }];
      }
    }
  }

  function unquote(raw: string): string {
    return raw.trim().replace(/^'|'$/g, "").replace(/\\(.)/g, "$1");
  }

  function field(row: Row, path: string): unknown {
    return path.split(".").reduce<unknown>((v, k) => {
      if (v && typeof v === "object") {
        const next = (v as Record<string, unknown>)[k];
        return next && typeof next === "object" && "value" in (next as object) && k.endsWith("Ref") ? (next as { value: unknown }).value : next;
      }
      return undefined;
    }, row);
  }

  function runQuery(q: string): Response {
    const m = q.match(/^select \* from (\w+)(?: where (.+?))?(?: startposition (\d+))?(?: maxresults (\d+))?$/i);
    if (!m) return fault(400, "4000", `Error parsing query: ${q}`, "ValidationFault");
    const [, entity, where, start = "1", max = "100"] = m;
    const table = tables[entity];
    if (!table) return fault(400, "4001", `Invalid entity ${entity}`);
    let rows = [...table.values()];
    for (const cond of where ? where.split(/ and /i) : []) {
      const c = cond.match(/^([\w.]+)\s*(>=|=|in)\s*(.+)$/i);
      if (!c) return fault(400, "4000", `Error parsing query: ${q}`);
      const [, path, op, raw] = c;
      if (op.toLowerCase() === "in") {
        const values = raw.replace(/^\(|\)$/g, "").split(",").map(unquote);
        rows = rows.filter((r) => values.includes(String(field(r, path))));
      } else if (op === ">=") {
        const bound = Date.parse(unquote(raw));
        rows = rows.filter((r) => Date.parse(String(field(r, path))) >= bound);
      } else {
        rows = rows.filter((r) => String(field(r, path)) === unquote(raw));
      }
    }
    if (entity === "Item" || entity === "Vendor") rows = rows.filter((r) => r.Active !== false);
    const page = rows.slice(Number(start) - 1, Number(start) - 1 + Number(max));
    return json(200, {
      QueryResponse: page.length ? { [entity]: page, startPosition: Number(start), maxResults: page.length } : {},
      time: stamp(),
    });
  }

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
    const method = init?.method ?? "GET";
    const rawBody = typeof init?.body === "string" ? init.body : undefined;
    const headers = new Headers(init?.headers);

    if (url.toString() === TOKEN_URL) {
      requests.push({ method, url, body: rawBody });
      const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
      if (headers.get("authorization") !== `Basic ${basic}`) return json(401, { error: "invalid_client" });
      const form = new URLSearchParams(rawBody);
      if (form.get("grant_type") === "refresh_token" && form.get("refresh_token") !== state.refreshToken) {
        return json(400, { error: "invalid_grant" });
      }
      refreshCount++;
      state.accessToken = `access-${refreshCount}`;
      state.refreshToken = `refresh-${refreshCount}`;
      return json(200, {
        token_type: "bearer",
        access_token: state.accessToken,
        refresh_token: state.refreshToken,
        expires_in: 3600,
        x_refresh_token_expires_in: 8_726_400,
      });
    }

    const body = rawBody ? JSON.parse(rawBody) : undefined;
    requests.push({ method, url, body });
    const prefix = `/v3/company/${realmId}/`;
    if (url.origin !== "https://sandbox-quickbooks.api.intuit.com" || !url.pathname.startsWith(prefix)) {
      return json(404, { error: "not found" });
    }
    if (headers.get("authorization") !== `Bearer ${state.accessToken}`) {
      return fault(401, "3200", "AuthenticationFailed", "AUTHENTICATION");
    }
    if (url.searchParams.get("minorversion") !== "75") return fault(400, "4000", "minorversion missing");
    const path = url.pathname.slice(prefix.length);

    if (method === "GET" && path === "query") return runQuery(url.searchParams.get("query") ?? "");
    if (method === "GET") {
      const [kind, id] = path.split("/");
      const entity = Object.keys(tables).find((k) => k.toLowerCase() === kind);
      const row = entity && tables[entity].get(decodeURIComponent(id ?? ""));
      if (!entity || !row) return fault(400, "610", "Object Not Found : Something you're trying to use has been made inactive or deleted");
      return json(200, { [entity]: row, time: stamp() });
    }
    if (method === "POST") {
      const entity = Object.keys(tables).find((k) => k.toLowerCase() === path);
      if (!entity) return fault(400, "4001", "Unsupported operation");
      const requestId = url.searchParams.get("requestid");
      if (requestId && requestIds.has(requestId)) return json(200, requestIds.get(requestId));
      hooks.beforeWrite?.(entity, body);
      const result = body.Id ? update(entity, body) : insert(entity, body);
      if (result instanceof Response) return result;
      if (entity === "Bill") linkBill(result);
      const response = { [entity]: result, time: stamp() };
      if (requestId) requestIds.set(requestId, response);
      if (hooks.failAfterWrite?.(entity, body)) throw new TypeError("fetch failed");
      return json(200, response);
    }
    return fault(400, "4001", "Unsupported operation");
  };

  return {
    realmId,
    clientId,
    clientSecret,
    fetch: fetchImpl,
    tables,
    requests,
    hooks,
    tokens: state,
    seed(entity: keyof typeof tables, row: Record<string, unknown>): Row {
      return insert(entity, row);
    },
    /** Edits a PO the way a QuickBooks user would, moving its SyncToken. */
    touch(poId: string) {
      const po = tables.PurchaseOrder.get(poId)!;
      update("PurchaseOrder", { Id: poId, SyncToken: po.SyncToken, sparse: true, Memo: `edited ${po.SyncToken}` });
    },
    /** Records a vendor bill against a PO line (QBO's only receiving signal). */
    bill(poId: string, lineId: string, qty: number) {
      const po = tables.PurchaseOrder.get(poId)!;
      const line = (po.Line as Row[]).find((l) => l.Id === lineId)!;
      const detail = line.ItemBasedExpenseLineDetail as Record<string, unknown>;
      const bill = insert("Bill", {
        VendorRef: po.VendorRef,
        TxnDate: now().toISOString().slice(0, 10),
        Line: [
          {
            DetailType: "ItemBasedExpenseLineDetail",
            Amount: qty * Number(detail.UnitPrice ?? 0),
            ItemBasedExpenseLineDetail: { ...detail, Qty: qty },
            LinkedTxn: [{ TxnId: poId, TxnType: "PurchaseOrder", TxnLineId: lineId }],
          },
        ],
      });
      linkBill(bill);
      return bill;
    },
  };
}
export type MockQbo = ReturnType<typeof createMockQbo>;

export function seedQboCompany(qbo: MockQbo) {
  const vendor = qbo.seed("Vendor", { DisplayName: "Bay Carton Co", Active: true, PrimaryEmailAddr: { Address: "orders@baycarton.test" } });
  const item = qbo.seed("Item", { Name: "Shipping carton", Sku: "CARTON-302015", Type: "Inventory", Active: true, TrackQtyOnHand: true, QtyOnHand: 600 });
  const tape = qbo.seed("Item", { Name: "Packing tape", Type: "Inventory", Active: true, TrackQtyOnHand: true, QtyOnHand: 12.5 });
  qbo.seed("Item", { Name: "Freight", Type: "Service", Active: true });
  const line = (itemRow: Row, qty: number, price: number) => ({
    DetailType: "ItemBasedExpenseLineDetail",
    Amount: qty * price,
    Description: itemRow.Name,
    ItemBasedExpenseLineDetail: { ItemRef: { value: itemRow.Id, name: itemRow.Name }, Qty: qty, UnitPrice: price, BillableStatus: "NotBillable" },
  });
  const header = {
    VendorRef: { value: vendor.Id, name: vendor.DisplayName },
    APAccountRef: { value: "33", name: "Accounts Payable (A/P)" },
    CurrencyRef: { value: "USD", name: "United States Dollar" },
    TxnDate: "2030-01-02",
    POStatus: "Open",
  };
  const single = qbo.seed("PurchaseOrder", { ...header, DocNumber: "1001", DueDate: "2030-01-14", Line: [line(item, 4000, 0.42)] });
  const multi = qbo.seed("PurchaseOrder", { ...header, DocNumber: "1002", DueDate: "2030-01-15", Line: [line(item, 100, 0.42), line(tape, 50, 1.25)] });
  const closed = qbo.seed("PurchaseOrder", { ...header, DocNumber: "1003", POStatus: "Closed", Line: [line(item, 10, 0.42)] });
  return { vendor, item, tape, single, multi, closed };
}
