/**
 * MOCKED HTTP: an in-memory stand-in for Zoho Inventory API v1, shaped after Zoho's published
 * OpenAPI examples (string IDs, `code`/`message` envelopes, page_context, last_modified_time).
 * Passing tests against it is not evidence of a real Zoho run.
 */
export const SIM_ORG_ID = "10234695";
export const SIM_ACCOUNTS = "https://accounts.zoho.com";
export const SIM_API = "https://www.zohoapis.com/inventory/v1";

interface SimLine {
  line_item_id: string;
  item_id: string;
  name: string;
  quantity: number;
  quantity_received: number;
  purchase_rate: number;
  unit: string;
  location_id: string;
}

interface SimPo {
  purchaseorder_id: string;
  purchaseorder_number: string;
  status: string;
  vendor_id: string;
  vendor_name: string;
  currency_code: string;
  reference_number: string;
  date: string;
  delivery_date: string;
  expected_delivery_date: string;
  notes: string;
  last_modified_time: string;
  location_id: string;
  line_items: SimLine[];
}

export interface SimRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  authorization: string | null;
}

function omit<T extends object, K extends keyof T>(record: T, ...keys: K[]): Omit<T, K> {
  const copy = { ...record };
  for (const key of keys) delete copy[key];
  return copy;
}

export function createZohoSimulator() {
  let seq = 4815000000044900;
  let clock = 0;
  const nextId = () => String((seq += 7));
  const stamp = () => `2030-01-01T10:${String(Math.floor(clock / 60) % 60).padStart(2, "0")}:${String(clock++ % 60).padStart(2, "0")}+0000`;
  const requests: SimRequest[] = [];
  const failures: { method: string; pathPattern: RegExp; status: number; body?: unknown; network?: boolean }[] = [];
  let tokenCounter = 0;
  let validTokens = new Set<string>();

  const pos = new Map<string, SimPo>();
  const receives = new Map<string, { receive_id: string; purchaseorder_id: string; date: string; status: string; created_time: string; last_modified_time: string; line_items: { line_item_id: string; item_id: string; quantity: number }[] }>();
  const items = new Map([
    ["4815000000044100", {
      item_id: "4815000000044100", name: "Shipping carton", sku: "CARTON-302015", unit: "carton",
      locations: [
        { location_id: "460000000038080", location_name: "Main Warehouse", location_stock_on_hand: 600 },
        { location_id: "460000000038090", location_name: "Overflow", location_stock_on_hand: 25 },
      ],
    }],
  ]);
  const salesorders = new Map([
    ["4815000000045000", {
      salesorder_id: "4815000000045000", status: "confirmed", date: "2030-01-05", shipment_date: "2030-01-12",
      location_id: "460000000038080",
      line_items: [{ line_item_id: "4815000000045001", item_id: "4815000000044100", quantity: 900, quantity_shipped: 100, location_id: "460000000038080" }],
    }],
    ["4815000000045100", {
      salesorder_id: "4815000000045100", status: "fulfilled", date: "2030-01-01", shipment_date: "2030-01-02",
      location_id: "460000000038080",
      line_items: [{ line_item_id: "4815000000045101", item_id: "4815000000044100", quantity: 5, quantity_shipped: 5, location_id: "460000000038080" }],
    }],
  ]);

  function seedPo(overrides: Partial<SimPo> = {}, lines: Partial<SimLine>[] = [{}]): SimPo {
    const id = nextId();
    const po: SimPo = {
      purchaseorder_id: id,
      purchaseorder_number: `PO-${pos.size + 1}`,
      status: "issued",
      vendor_id: "460000000026049",
      vendor_name: "Bay Carton",
      currency_code: "USD",
      reference_number: "",
      date: "2030-01-02",
      delivery_date: "2030-01-14",
      expected_delivery_date: "2030-01-14",
      notes: "Sample Note",
      last_modified_time: stamp(),
      location_id: "460000000038080",
      line_items: lines.map((line) => ({
        line_item_id: nextId(),
        item_id: "4815000000044100",
        name: "Shipping carton",
        quantity: 4000,
        quantity_received: 0,
        purchase_rate: 0.42,
        unit: "carton",
        location_id: "460000000038080",
        ...line,
      })),
      ...overrides,
    };
    pos.set(id, po);
    return po;
  }

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const okJson = (body: Record<string, unknown>) => json(200, { code: 0, message: "success", ...body });
  const notFound = () => json(404, { code: 1002, message: "Resource does not exist." });
  const page = <T>(all: T[], query: URLSearchParams, key: string) => {
    const per = Number(query.get("per_page") ?? 200);
    const p = Number(query.get("page") ?? 1);
    return okJson({
      [key]: all.slice((p - 1) * per, p * per),
      page_context: { page: p, per_page: per, has_more_page: p * per < all.length },
    });
  };

  function applyPoWrite(po: SimPo, body: Record<string, unknown>) {
    if (typeof body.delivery_date === "string") {
      po.delivery_date = body.delivery_date;
      po.expected_delivery_date = body.delivery_date;
    }
    if (typeof body.notes === "string") po.notes = body.notes;
    if (typeof body.reference_number === "string") po.reference_number = body.reference_number;
    if (Array.isArray(body.line_items)) {
      po.line_items = (body.line_items as Record<string, unknown>[]).map((line) => {
        const existing = po.line_items.find((candidate) => candidate.line_item_id === line.line_item_id);
        return {
          line_item_id: existing?.line_item_id ?? nextId(),
          item_id: String(line.item_id),
          name: existing?.name ?? "Shipping carton",
          quantity: Number(line.quantity),
          quantity_received: existing?.quantity_received ?? 0,
          purchase_rate: Number(line.purchase_rate ?? existing?.purchase_rate ?? 0),
          unit: String(line.unit ?? existing?.unit ?? ""),
          location_id: String(line.location_id ?? existing?.location_id ?? po.location_id),
        };
      });
    }
    po.last_modified_time = stamp();
  }

  async function handle(url: URL, init: RequestInit): Promise<Response> {
    const method = (init.method ?? "GET").toUpperCase();
    if (url.origin === SIM_ACCOUNTS && url.pathname === "/oauth/v2/token") {
      const form = new URLSearchParams(String(init.body));
      if (form.get("grant_type") === "refresh_token" && form.get("refresh_token") !== "sim-refresh") {
        return json(200, { error: "invalid_code" });
      }
      const token = `sim-access-${++tokenCounter}`;
      validTokens.add(token);
      return json(200, { access_token: token, api_domain: "https://www.zohoapis.com", token_type: "Bearer", expires_in: 3600 });
    }
    if (!url.href.startsWith(SIM_API)) return json(404, { code: 404, message: "unknown host" });
    const path = url.pathname.slice(new URL(SIM_API).pathname.length);
    const headers = new Headers(init.headers);
    const token = headers.get("authorization")?.replace(/^Zoho-oauthtoken /, "") ?? "";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, path, query: url.searchParams, body, authorization: headers.get("authorization") });

    const failure = failures.find((f) => f.method === method && f.pathPattern.test(path));
    if (failure) {
      failures.splice(failures.indexOf(failure), 1);
      if (failure.network) throw new TypeError("fetch failed");
      return json(failure.status, failure.body ?? { code: 9999, message: "Simulated failure" });
    }
    if (!validTokens.has(token)) return json(401, { code: 57, message: "You are not authorized to perform this operation" });
    if (url.searchParams.get("organization_id") !== SIM_ORG_ID) return json(400, { code: 6041, message: "Invalid organization" });

    let m: RegExpExecArray | null;
    if (method === "GET" && path === "/locations") {
      return okJson({ locations: [
        { location_id: "460000000038080", location_name: "Main Warehouse", status: "active" },
        { location_id: "460000000038090", location_name: "Overflow", status: "active" },
      ] });
    }
    if (method === "GET" && path === "/purchaseorders") {
      const ref = url.searchParams.get("reference_number");
      const all = [...pos.values()]
        .filter((po) => !ref || po.reference_number === ref)
        .map((po) => omit(po, "line_items", "notes"));
      return page(all, url.searchParams, "purchaseorders");
    }
    if (method === "POST" && path === "/purchaseorders") {
      const po = seedPo({ status: "draft", reference_number: "", notes: "" }, []);
      applyPoWrite(po, body);
      return json(201, { code: 0, message: "Purchase Order has been created.", purchaseorder: po });
    }
    if ((m = /^\/purchaseorders\/(\d+)$/.exec(path))) {
      const po = pos.get(m[1]);
      if (!po) return notFound();
      if (method === "GET") return okJson({ purchaseorder: po });
      if (method === "PUT") {
        applyPoWrite(po, body);
        return okJson({ message: "Purchase Order has been updated.", purchaseorder: po });
      }
    }
    if (method === "POST" && (m = /^\/purchaseorders\/(\d+)\/status\/(issued|cancelled)$/.exec(path))) {
      const po = pos.get(m[1]);
      if (!po) return notFound();
      po.status = m[2];
      po.last_modified_time = stamp();
      return okJson({ message: `Purchase Order status has been changed to ${m[2]}.` });
    }
    if (method === "GET" && (m = /^\/items\/(\d+)$/.exec(path))) {
      const item = items.get(m[1]);
      return item ? okJson({ item }) : notFound();
    }
    if (method === "GET" && path === "/salesorders") {
      return page([...salesorders.values()].map((so) => omit(so, "line_items")), url.searchParams, "salesorders");
    }
    if (method === "GET" && (m = /^\/salesorders\/(\d+)$/.exec(path))) {
      const so = salesorders.get(m[1]);
      return so ? okJson({ salesorder: so }) : notFound();
    }
    if (method === "GET" && path === "/purchasereceives") {
      return page(
        [...receives.values()].map(({ receive_id, ...receive }) => ({ ...omit(receive, "line_items"), purchasereceive_id: receive_id })),
        url.searchParams,
        "purchasereceives",
      );
    }
    if (method === "GET" && (m = /^\/purchasereceives\/(\d+)$/.exec(path))) {
      const receive = receives.get(m[1]);
      return receive ? okJson({ purchasereceive: receive }) : notFound();
    }
    if (method === "POST" && path === "/purchasereceives") {
      const po = pos.get(url.searchParams.get("purchaseorder_id") ?? "");
      if (!po) return notFound();
      const lines = (body.line_items as { line_item_id: string; quantity: number }[]).map((line) => {
        const target = po.line_items.find((candidate) => candidate.line_item_id === line.line_item_id);
        if (target) target.quantity_received += line.quantity;
        return { line_item_id: nextId(), item_id: target?.item_id ?? "", quantity: line.quantity };
      });
      po.status = "partially_received";
      po.last_modified_time = stamp();
      const now = new Date().toISOString();
      const receive = { receive_id: nextId(), purchaseorder_id: po.purchaseorder_id, date: String(body.date), status: "received", created_time: now, last_modified_time: now, line_items: lines };
      receives.set(receive.receive_id, receive);
      return json(201, { code: 0, message: "Purchase Receive created.", purchasereceive: receive });
    }
    return json(405, { code: 405, message: `${method} ${path} not simulated` });
  }

  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) =>
    handle(new URL(typeof input === "string" || input instanceof URL ? input : input.url), init)) as typeof fetch;

  return {
    fetch: fetchImpl,
    requests,
    pos,
    seedPo,
    failNext(method: string, pathPattern: RegExp, status: number, options: { body?: unknown; network?: boolean } = {}) {
      failures.push({ method, pathPattern, status, ...options });
    },
    expireTokens() {
      validTokens = new Set();
    },
    touch(poId: string) {
      const po = pos.get(poId)!;
      po.notes = `${po.notes} (edited in Zoho)`;
      po.last_modified_time = stamp();
    },
    receive(poId: string, lineId: string, quantity: number) {
      validTokens.add("sim-internal");
      return handle(new URL(`${SIM_API}/purchasereceives?organization_id=${SIM_ORG_ID}&purchaseorder_id=${poId}`), {
        method: "POST",
        headers: { authorization: "Zoho-oauthtoken sim-internal" },
        body: JSON.stringify({ date: "2030-01-09", line_items: [{ line_item_id: lineId, quantity }] }),
      });
    },
  };
}

export const simCredentials = {
  refresh_token: "sim-refresh",
  api_domain: "https://www.zohoapis.com",
  accounts_server: SIM_ACCOUNTS,
  organization_id: SIM_ORG_ID,
};
