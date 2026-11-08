import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixedClock } from "@/lib/agent/clock";
import {
  createPageFetcher,
  createNodePinnedTransport,
  nodePinnedTransport,
  selectPageFetcher,
  type HostResolver,
  type PinnedRequest,
  type PinnedResponse,
  type PinnedTransport,
} from "@/lib/integrations/page-fetch";

const clock = fixedClock("2026-10-12T15:00:00Z");
const PUBLIC_IP = "93.184.216.34";
const HTML = "<html><body><h1>Kraft cartons</h1><script>alert(1)</script><p>300x200x150 mm</p></body></html>";

interface Reply {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array | AsyncIterable<Uint8Array>;
}

function bodyOf(reply: Reply): AsyncIterable<Uint8Array> {
  const body = reply.body ?? HTML;
  if (typeof body === "string") {
    return (async function* () {
      yield new TextEncoder().encode(body);
    })();
  }
  if (body instanceof Uint8Array) {
    return (async function* () {
      yield body;
    })();
  }
  return body;
}

/** Scripted transport keyed by "host/path". Records every pinned request. */
function scripted(routes: Record<string, Reply>) {
  const requests: PinnedRequest[] = [];
  const destroyed: string[] = [];
  const transport: PinnedTransport = async (request) => {
    requests.push(request);
    const key = `${request.url.host}${request.url.pathname}`;
    const reply = routes[key];
    if (!reply) throw new Error(`unscripted ${key}`);
    const response: PinnedResponse = {
      status: reply.status ?? 200,
      headers: { "content-type": "text/html; charset=utf-8", ...(reply.headers ?? {}) },
      body: bodyOf(reply),
      destroy: () => destroyed.push(key),
    };
    return response;
  };
  return { transport, requests, destroyed };
}

function resolver(map: Record<string, string[]>): HostResolver & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (hostname: string) => {
    calls.push(hostname);
    const addresses = map[hostname];
    if (!addresses) throw new Error("ENOTFOUND");
    return addresses.map((address) => ({ address, family: (address.includes(":") ? 6 : 4) as 4 | 6 }));
  }) as HostResolver & { calls: string[] };
  fn.calls = calls;
  return fn;
}

function build(
  routes: Record<string, Reply>,
  dns: Record<string, string[]>,
  extra: Partial<Parameters<typeof createPageFetcher>[0]> = {},
) {
  const s = scripted(routes);
  const r = resolver(dns);
  const fetcher = createPageFetcher({ clock, resolve: r, transport: s.transport, ...extra });
  return { fetcher, ...s, resolver: r };
}

describe("direct page fetcher: happy path", () => {
  it("fetches, pins the validated IP, extracts text and hashes the raw bytes", async () => {
    const { fetcher, requests } = build(
      { "supplier.example.com/p": { body: HTML } },
      { "supplier.example.com": [PUBLIC_IP] },
    );
    const result = await fetcher.fetchPage("https://supplier.example.com/p");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.final_url).toBe("https://supplier.example.com/p");
    expect(result.fetched_at).toBe("2026-10-12T15:00:00.000Z");
    expect(result.content_type).toBe("text/html");
    expect(result.text).toBe("Kraft cartons 300x200x150 mm");
    expect(result.text).not.toContain("alert");
    expect(result.content_hash).toBe(createHash("sha256").update(HTML).digest("hex"));
    expect(result.bytes).toBe(Buffer.byteLength(HTML));
    expect(requests).toHaveLength(1);
    expect(requests[0].address).toBe(PUBLIC_IP);
    expect(requests[0].hostname).toBe("supplier.example.com");
    expect(requests[0].headers["accept-encoding"]).toBe("identity");
  });

  it("accepts text/plain without tag stripping", async () => {
    const { fetcher } = build(
      { "supplier.example.com/p.txt": { headers: { "content-type": "text/plain" }, body: "a <b> c" } },
      { "supplier.example.com": [PUBLIC_IP] },
    );
    const result = await fetcher.fetchPage("https://supplier.example.com/p.txt");
    expect(result.ok && result.text).toBe("a <b> c");
  });

  it("truncates extracted text to maxChars but still hashes all bytes", async () => {
    const body = `<p>${"x".repeat(500)}</p>`;
    const { fetcher } = build(
      { "supplier.example.com/long": { body } },
      { "supplier.example.com": [PUBLIC_IP] },
      { limits: { maxChars: 100 } },
    );
    const result = await fetcher.fetchPage("https://supplier.example.com/long");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toHaveLength(100);
    expect(result.truncated).toBe(true);
    expect(result.content_hash).toBe(createHash("sha256").update(body).digest("hex"));
  });
});

describe("direct page fetcher: SSRF rejection before any network", () => {
  const cases: [string, string][] = [
    ["http://localhost/admin", "blocked_host"],
    ["http://127.0.0.1/", "blocked_address"],
    ["http://10.1.2.3/", "blocked_address"],
    ["http://172.20.0.1/", "blocked_address"],
    ["http://192.168.0.10/", "blocked_address"],
    ["http://169.254.169.254/latest/meta-data/iam/security-credentials/", "blocked_address"],
    ["http://[::1]/", "blocked_address"],
    ["http://[::ffff:169.254.169.254]/", "blocked_address"],
    ["http://2130706433/", "blocked_address"],
    ["file:///etc/passwd", "unsafe_scheme"],
    ["ftp://supplier.example.com/", "unsafe_scheme"],
    ["https://user:pw@supplier.example.com/", "credentials_in_url"],
    ["http://supplier.example.com:6379/", "blocked_port"],
  ];

  it.each(cases)("%s -> %s without resolving or connecting", async (url, code) => {
    const { fetcher, requests, resolver: r } = build({}, {});
    const result = await fetcher.fetchPage(url);
    expect(result).toMatchObject({ ok: false, code });
    expect(requests).toHaveLength(0);
    expect(r.calls).toHaveLength(0);
  });

  it("rejects a hostname whose DNS answer is private (DNS pointing at internal space)", async () => {
    const { fetcher, requests } = build({}, { "rebind.example.com": ["10.0.0.7"] });
    const result = await fetcher.fetchPage("https://rebind.example.com/");
    expect(result).toMatchObject({ ok: false, code: "blocked_address" });
    expect(requests).toHaveLength(0);
  });

  it("rejects when ANY DNS answer is private (mixed A records)", async () => {
    const { fetcher, requests } = build(
      {},
      { "mixed.example.com": [PUBLIC_IP, "169.254.169.254"] },
    );
    const result = await fetcher.fetchPage("https://mixed.example.com/");
    expect(result).toMatchObject({ ok: false, code: "blocked_address" });
    expect(requests).toHaveLength(0);
  });

  it("rejects IPv6 DNS answers that wrap private IPv4", async () => {
    const { fetcher } = build({}, { "v6.example.com": ["::ffff:127.0.0.1"] });
    expect(await fetcher.fetchPage("https://v6.example.com/")).toMatchObject({
      ok: false,
      code: "blocked_address",
    });
  });

  it("reports dns_failed for unresolvable hosts and empty answers", async () => {
    const { fetcher } = build({}, { "empty.example.com": [] });
    expect(await fetcher.fetchPage("https://nxdomain.example.com/")).toMatchObject({
      ok: false,
      code: "dns_failed",
    });
    expect(await fetcher.fetchPage("https://empty.example.com/")).toMatchObject({
      ok: false,
      code: "dns_failed",
    });
  });

  it("enforces the env allowlist before resolving", async () => {
    const { fetcher, requests, resolver: r } = build(
      { "ok.example.com/": {} },
      { "ok.example.com": [PUBLIC_IP], "other.example.org": [PUBLIC_IP] },
      { allowlist: ["example.com"] },
    );
    expect(await fetcher.fetchPage("https://other.example.org/")).toMatchObject({
      ok: false,
      code: "not_allowlisted",
    });
    expect(r.calls).toEqual([]);
    expect((await fetcher.fetchPage("https://ok.example.com/")).ok).toBe(true);
    expect(requests).toHaveLength(1);
  });
});

describe("direct page fetcher: redirects", () => {
  const dns = {
    "a.example.com": [PUBLIC_IP],
    "b.example.com": ["93.184.216.35"],
    "evil.example.com": ["10.0.0.9"],
    "rebind.example.com": ["169.254.169.254"],
  };

  it("follows a public redirect, re-resolving and re-pinning each hop", async () => {
    const { fetcher, requests, resolver: r } = build(
      {
        "a.example.com/start": { status: 302, headers: { location: "https://b.example.com/final" } },
        "b.example.com/final": { body: "<p>done</p>" },
      },
      dns,
    );
    const result = await fetcher.fetchPage("https://a.example.com/start");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.final_url).toBe("https://b.example.com/final");
    expect(result.redirects).toEqual(["https://b.example.com/final"]);
    expect(r.calls).toEqual(["a.example.com", "b.example.com"]);
    expect(requests.map((q) => q.address)).toEqual([PUBLIC_IP, "93.184.216.35"]);
  });

  it("resolves relative redirects against the current URL", async () => {
    const { fetcher } = build(
      {
        "a.example.com/start": { status: 301, headers: { location: "/next?x=1" } },
        "a.example.com/next": { body: "<p>ok</p>" },
      },
      dns,
    );
    const result = await fetcher.fetchPage("https://a.example.com/start");
    expect(result.ok && result.final_url).toBe("https://a.example.com/next?x=1");
  });

  it.each([
    ["http://127.0.0.1/", "loopback literal"],
    ["http://localhost:80/", "localhost"],
    ["http://169.254.169.254/latest/meta-data/", "metadata literal"],
    ["http://[::1]/", "IPv6 loopback"],
    ["http://2130706433/", "decimal loopback"],
    ["file:///etc/passwd", "file scheme"],
    ["https://user:pw@b.example.com/", "credentials"],
    ["https://evil.example.com/", "hostname resolving to 10/8"],
    ["https://rebind.example.com/", "hostname resolving to metadata IP"],
  ])("blocks a redirect into %s (%s) and never connects to it", async (location) => {
    const { fetcher, requests } = build(
      { "a.example.com/start": { status: 302, headers: { location } } },
      dns,
    );
    const result = await fetcher.fetchPage("https://a.example.com/start");
    expect(result).toMatchObject({ ok: false, code: "redirect_blocked" });
    // Only the first (public) hop was ever requested.
    expect(requests).toHaveLength(1);
    expect(requests[0].url.host).toBe("a.example.com");
  });

  it("blocks https -> http downgrade redirects", async () => {
    const { fetcher, requests } = build(
      { "a.example.com/start": { status: 302, headers: { location: "http://b.example.com/" } } },
      dns,
    );
    expect(await fetcher.fetchPage("https://a.example.com/start")).toMatchObject({
      ok: false,
      code: "redirect_blocked",
    });
    expect(requests).toHaveLength(1);
  });

  it("re-applies the allowlist on every hop", async () => {
    const { fetcher, requests } = build(
      { "a.example.com/start": { status: 302, headers: { location: "https://b.example.net/" } } },
      { ...dns, "b.example.net": [PUBLIC_IP] },
      { allowlist: ["example.com"] },
    );
    expect(await fetcher.fetchPage("https://a.example.com/start")).toMatchObject({
      ok: false,
      code: "redirect_blocked",
    });
    expect(requests).toHaveLength(1);
  });

  it("stops redirect loops and chains beyond maxRedirects", async () => {
    const { fetcher, requests } = build(
      { "a.example.com/loop": { status: 302, headers: { location: "/loop" } } },
      dns,
      { limits: { maxRedirects: 3 } },
    );
    expect(await fetcher.fetchPage("https://a.example.com/loop")).toMatchObject({
      ok: false,
      code: "too_many_redirects",
    });
    expect(requests).toHaveLength(4); // initial + 3 followed
  });

  it("rejects an invalid Location header", async () => {
    const { fetcher } = build(
      { "a.example.com/start": { status: 302, headers: { location: "http://[bad" } } },
      dns,
    );
    expect(await fetcher.fetchPage("https://a.example.com/start")).toMatchObject({
      ok: false,
      code: "redirect_blocked",
    });
  });

  it("destroys redirect response bodies instead of reading them", async () => {
    const { fetcher, destroyed } = build(
      {
        "a.example.com/start": { status: 302, headers: { location: "/n" } },
        "a.example.com/n": {},
      },
      dns,
    );
    await fetcher.fetchPage("https://a.example.com/start");
    expect(destroyed).toContain("a.example.com/start");
  });
});

describe("direct page fetcher: size, type, status and time bounds", () => {
  const dns = { "supplier.example.com": [PUBLIC_IP] };

  it("rejects a huge declared Content-Length before reading the body", async () => {
    let pulled = false;
    const body = (async function* () {
      pulled = true;
      yield new Uint8Array(10);
    })();
    const { fetcher } = build(
      { "supplier.example.com/big": { headers: { "content-length": "999999999" }, body } },
      dns,
    );
    expect(await fetcher.fetchPage("https://supplier.example.com/big")).toMatchObject({
      ok: false,
      code: "too_large",
    });
    expect(pulled).toBe(false);
  });

  it("aborts a streamed body that lies about (or omits) Content-Length", async () => {
    let chunksServed = 0;
    const body = (async function* () {
      for (let i = 0; i < 1_000_000; i += 1) {
        chunksServed += 1;
        yield new Uint8Array(64 * 1024);
      }
    })();
    const { fetcher, destroyed } = build(
      { "supplier.example.com/endless": { headers: { "content-length": "10" }, body } },
      dns,
      { limits: { maxBytes: 1_000_000 } },
    );
    const result = await fetcher.fetchPage("https://supplier.example.com/endless");
    expect(result).toMatchObject({ ok: false, code: "too_large" });
    expect(chunksServed).toBeLessThan(100);
    expect(destroyed).toContain("supplier.example.com/endless");
  });

  it("accepts a body exactly at the cap and rejects one byte over", async () => {
    const at = new Uint8Array(1000).fill(97);
    const over = new Uint8Array(1001).fill(97);
    const { fetcher } = build(
      {
        "supplier.example.com/at": { headers: { "content-type": "text/plain" }, body: at },
        "supplier.example.com/over": { headers: { "content-type": "text/plain" }, body: over },
      },
      dns,
      { limits: { maxBytes: 1000 } },
    );
    expect((await fetcher.fetchPage("https://supplier.example.com/at")).ok).toBe(true);
    expect(await fetcher.fetchPage("https://supplier.example.com/over")).toMatchObject({
      ok: false,
      code: "too_large",
    });
  });

  it.each([
    "application/pdf",
    "application/octet-stream",
    "image/png",
    "application/json",
    "application/zip",
    "",
  ])("rejects content type %j", async (contentType) => {
    const { fetcher } = build(
      { "supplier.example.com/x": { headers: { "content-type": contentType } } },
      dns,
    );
    expect(await fetcher.fetchPage("https://supplier.example.com/x")).toMatchObject({
      ok: false,
      code: "unsupported_content_type",
    });
  });

  it.each([401, 403, 404, 500, 503, 199])("reports http_error for status %i", async (status) => {
    const { fetcher } = build({ "supplier.example.com/x": { status } }, dns);
    expect(await fetcher.fetchPage("https://supplier.example.com/x")).toMatchObject({
      ok: false,
      code: "http_error",
    });
  });

  it("times out a server that never sends headers", async () => {
    const hang: PinnedTransport = () => new Promise<PinnedResponse>(() => undefined);
    const fetcher = createPageFetcher({
      clock,
      resolve: resolver(dns),
      transport: hang,
      limits: { totalTimeoutMs: 40 },
    });
    expect(await fetcher.fetchPage("https://supplier.example.com/")).toMatchObject({
      ok: false,
      code: "timeout",
    });
  });

  it("times out a slow-loris body that never finishes", async () => {
    const body = (async function* () {
      yield new TextEncoder().encode("<p>start</p>");
      await new Promise(() => undefined);
    })();
    const { fetcher, destroyed } = build(
      { "supplier.example.com/slow": { body } },
      dns,
      { limits: { totalTimeoutMs: 40 } },
    );
    expect(await fetcher.fetchPage("https://supplier.example.com/slow")).toMatchObject({
      ok: false,
      code: "timeout",
    });
    expect(destroyed).toContain("supplier.example.com/slow");
  });

  it("times out a hanging DNS lookup", async () => {
    const stuck: HostResolver = () => new Promise(() => undefined);
    const fetcher = createPageFetcher({
      clock,
      resolve: stuck,
      transport: scripted({}).transport,
      limits: { totalTimeoutMs: 40 },
    });
    expect(await fetcher.fetchPage("https://supplier.example.com/")).toMatchObject({
      ok: false,
      code: "timeout",
    });
  });

  it("shares one time budget across redirect hops", async () => {
    const slowResolver: HostResolver = async () => {
      await new Promise((r) => setTimeout(r, 25));
      return [{ address: PUBLIC_IP, family: 4 }];
    };
    const { transport } = scripted({
      "supplier.example.com/a": { status: 302, headers: { location: "/b" } },
      "supplier.example.com/b": { status: 302, headers: { location: "/c" } },
      "supplier.example.com/c": { status: 302, headers: { location: "/d" } },
      "supplier.example.com/d": {},
    });
    const fetcher = createPageFetcher({
      clock,
      resolve: slowResolver,
      transport,
      limits: { totalTimeoutMs: 60, maxRedirects: 5 },
    });
    expect(await fetcher.fetchPage("https://supplier.example.com/a")).toMatchObject({
      ok: false,
      code: "timeout",
    });
  });

  it("maps transport failures to a generic network_error (no internals leaked)", async () => {
    const boom: PinnedTransport = async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.1:443 secret-detail");
    };
    const fetcher = createPageFetcher({ clock, resolve: resolver(dns), transport: boom });
    const result = await fetcher.fetchPage("https://supplier.example.com/");
    expect(result).toMatchObject({ ok: false, code: "network_error" });
    expect(JSON.stringify(result)).not.toContain("secret-detail");
    expect(JSON.stringify(result)).not.toContain("10.0.0.1");
  });
});

describe("selectPageFetcher gating", () => {
  const deps = { clock, resolve: resolver({}), transport: scripted({}).transport };

  it("is off by default, for blank/false values, and in replay mode", () => {
    expect(selectPageFetcher({}, "live", deps)).toBeUndefined();
    expect(selectPageFetcher({ DIRECT_PAGE_FETCH_ENABLED: "" }, "live", deps)).toBeUndefined();
    expect(selectPageFetcher({ DIRECT_PAGE_FETCH_ENABLED: "false" }, "sandbox", deps)).toBeUndefined();
    expect(selectPageFetcher({ DIRECT_PAGE_FETCH_ENABLED: "TRUE" }, "live", deps)).toBeUndefined();
    expect(selectPageFetcher({ DIRECT_PAGE_FETCH_ENABLED: "true" }, "replay", deps)).toBeUndefined();
  });

  it("is on only for exactly 'true' outside replay, and applies the allowlist", async () => {
    const fetcher = selectPageFetcher(
      { DIRECT_PAGE_FETCH_ENABLED: "true", DIRECT_PAGE_FETCH_ALLOWLIST: "example.com" },
      "sandbox",
      deps,
    );
    expect(fetcher).toBeDefined();
    expect(await fetcher!.fetchPage("https://evil.org/")).toMatchObject({
      ok: false,
      code: "not_allowlisted",
    });
  });
});

describe("nodePinnedTransport (real sockets)", () => {
  let server: Server | undefined;
  // Tests talk to a loopback server, so they opt out of the peer check that
  // production keeps on.
  const loopbackTransport = createNodePinnedTransport({ peerAllowed: () => true });

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  async function listen(handler: Parameters<typeof createServer>[1]): Promise<number> {
    server = createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
  }

  async function readAll(response: PinnedResponse): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
  }

  it("connects to the pinned IP (never re-resolving the hostname) and sends the original Host", async () => {
    let seenHost = "";
    let seenEncoding = "";
    const port = await listen((req, res) => {
      seenHost = req.headers.host ?? "";
      seenEncoding = String(req.headers["accept-encoding"]);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("pinned-ok");
    });
    const controller = new AbortController();
    const response = await loopbackTransport({
      // The hostname below does not resolve anywhere; only the pinned IP works.
      url: new URL(`http://pinned-host.invalid:${port}/path?q=1`),
      address: "127.0.0.1",
      family: 4,
      hostname: "pinned-host.invalid",
      headers: { "accept-encoding": "identity" },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("text/plain");
    expect(await readAll(response)).toBe("pinned-ok");
    expect(seenHost).toBe(`pinned-host.invalid:${port}`);
    expect(seenEncoding).toBe("identity");
  });

  it("does not auto-follow redirects (the fetcher validates each hop)", async () => {
    let hits = 0;
    const port = await listen((req, res) => {
      hits += 1;
      res.writeHead(302, { location: "http://127.0.0.1:1/never" });
      res.end();
    });
    const response = await loopbackTransport({
      url: new URL(`http://pinned-host.invalid:${port}/`),
      address: "127.0.0.1",
      family: 4,
      hostname: "pinned-host.invalid",
      headers: {},
      signal: new AbortController().signal,
    });
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe("http://127.0.0.1:1/never");
    response.destroy();
    expect(hits).toBe(1);
  });

  it("the production transport refuses a connection whose peer is non-public", async () => {
    const hit = vi.fn();
    const port = await listen((req, res) => {
      hit();
      res.end("internal");
    });
    await expect(
      nodePinnedTransport({
        url: new URL(`http://pinned-host.invalid:${port}/`),
        address: "127.0.0.1",
        family: 4,
        hostname: "pinned-host.invalid",
        headers: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/non-public/);
  });

  it("aborts via the signal", async () => {
    const port = await listen(() => undefined); // never responds
    const controller = new AbortController();
    const pending = loopbackTransport({
      url: new URL(`http://pinned-host.invalid:${port}/`),
      address: "127.0.0.1",
      family: 4,
      hostname: "pinned-host.invalid",
      headers: {},
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toBeDefined();
  });

  it("end-to-end: the public fetcher refuses a real loopback server even when DNS lies", async () => {
    const hit = vi.fn();
    const port = await listen((req, res) => {
      hit();
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("secret-internal");
    });
    const fetcher = createPageFetcher({
      clock,
      // DNS rebinding style answer: a public-looking name that points at loopback.
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    const result = await fetcher.fetchPage(`http://rebind.example.com:80/`);
    expect(result).toMatchObject({ ok: false, code: "blocked_address" });
    const direct = await fetcher.fetchPage(`http://127.0.0.1:${port}/`);
    expect(direct).toMatchObject({ ok: false, code: "blocked_port" });
    expect(hit).not.toHaveBeenCalled();
  });
});
