import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signShopifyState, verifyShopifyHmac } from "@/lib/integrations/business/live/shopify/oauth";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  storeErpConnection: vi.fn(),
  ErpNotConfiguredError: class extends Error {},
}));

vi.mock("@/lib/auth/membership", () => ({
  requireMembership: mocks.requireMembership,
  AuthenticationError: class extends Error {},
  AuthorizationError: class extends Error {},
}));

vi.mock("@/lib/integrations/business/live/connections", () => ({
  storeErpConnection: mocks.storeErpConnection,
  ErpNotConfiguredError: mocks.ErpNotConfiguredError,
}));

import { POST } from "@/app/api/auth/shopify/connect/route";
import { GET } from "@/app/api/auth/shopify/callback/route";

const signingKey = `v1:${Buffer.alloc(32, 7).toString("base64")}`;
const clientSecret = "shpss_test_secret";
const membership = { orgId: "org-1", userId: "user-1", role: "owner" };
const shop = "conduit-dev.myshopify.com";

function connect(body: unknown) {
  return POST(
    new Request("https://app.example.test/api/auth/shopify/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function signedCallback(params: Record<string, string>, nonce = "nonce-1") {
  const query = new URLSearchParams(params);
  const message = [...query.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&");
  query.set("hmac", createHmac("sha256", clientSecret).update(message).digest("hex"));
  return new Request(`https://app.example.test/api/auth/shopify/callback?${query}`, {
    headers: { cookie: `shopify_oauth_nonce=${nonce}` },
  });
}

function state(overrides: Partial<{ o: string; u: string; n: string; s: string; exp: number }> = {}) {
  return signShopifyState(
    { o: "org-1", u: "user-1", n: "nonce-1", s: shop, exp: Math.floor(Date.now() / 1000) + 600, ...overrides },
    signingKey,
  );
}

describe("Shopify auth routes", () => {
  beforeEach(() => {
    vi.stubEnv("APP_BASE_URL", "https://app.example.test");
    vi.stubEnv("APP_ENV", "sandbox");
    vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "test-publishable-key");
    vi.stubEnv("SUPABASE_SECRET_KEY", "test-secret-key");
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", signingKey);
    vi.stubEnv("SHOPIFY_CLIENT_ID", "shopify-client-id");
    vi.stubEnv("SHOPIFY_CLIENT_SECRET", clientSecret);
    mocks.requireMembership.mockResolvedValue(membership);
    mocks.storeErpConnection.mockResolvedValue({ connectionId: "conn-1" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("returns a Shopify authorization URL with minimal scopes and sets a nonce cookie", async () => {
    const response = await connect({ shop: "Conduit-Dev" });
    expect(response.status).toBe(200);
    const url = new URL(((await response.json()) as { data: { authorization_url: string } }).data.authorization_url);
    expect(url.origin).toBe("https://conduit-dev.myshopify.com");
    expect(url.pathname).toBe("/admin/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("shopify-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example.test/api/auth/shopify/callback");
    expect(url.searchParams.get("scope")?.split(",")).not.toContain("write_inventory_transfers");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(response.headers.get("set-cookie")).toMatch(/shopify_oauth_nonce=.+HttpOnly; Secure; SameSite=Lax/);
  });

  it("rejects shop domains outside myshopify.com", async () => {
    for (const bad of ["evil.com", "shop.myshopify.com.evil.com", "-x.myshopify.com", "a/b.myshopify.com"]) {
      const response = await connect({ shop: bad });
      expect(response.status).toBe(422);
    }
  });

  it("reports not configured without Shopify app credentials", async () => {
    vi.stubEnv("SHOPIFY_CLIENT_ID", "");
    const response = await connect({ shop });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("shopify_not_configured");

    const callback = await GET(signedCallback({ code: "c", shop, state: state(), timestamp: "1" }));
    expect(callback.headers.get("location")).toBe(
      "https://app.example.test/settings/integrations?business=error&provider=shopify&code=shopify_not_configured",
    );
  });

  it("exchanges the code for an expiring offline token and stores it org-scoped", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        access_token: "shpat_abc",
        scope: "read_inventory,write_inventory_shipments",
        expires_in: 3600,
        refresh_token: "shprt_abc",
        refresh_token_expires_in: 7776000,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const response = await GET(signedCallback({ code: "auth-code", shop, state: state(), timestamp: "1700000000" }));

    expect(response.headers.get("location")).toBe(
      "https://app.example.test/settings/integrations?business=connected&provider=shopify",
    );
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://${shop}/admin/oauth/access_token`);
    const body = new URLSearchParams(String(init.body));
    expect(body.get("code")).toBe("auth-code");
    expect(body.get("expiring")).toBe("1");
    expect(mocks.storeErpConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        actorUserId: "user-1",
        provider: "shopify",
        externalAccountId: shop,
        scopes: ["read_inventory", "write_inventory_shipments"],
        credentials: expect.objectContaining({ shop, access_token: "shpat_abc", refresh_token: "shprt_abc" }),
      }),
    );
  });

  it.each([
    ["a tampered HMAC", () => {
      const req = signedCallback({ code: "c", shop, state: state(), timestamp: "1" });
      return new Request(req.url.replace("code=c", "code=d"), { headers: req.headers });
    }, "shopify_bad_hmac"],
    ["a wrong nonce cookie", () => signedCallback({ code: "c", shop, state: state() }, "other"), "shopify_nonce_mismatch"],
    ["a state for another shop", () => signedCallback({ code: "c", shop, state: state({ s: "other.myshopify.com" }) }), "shopify_shop_mismatch"],
    ["a state for another org", () => signedCallback({ code: "c", shop, state: state({ o: "org-2" }) }), "shopify_org_mismatch"],
    ["an expired state", () => signedCallback({ code: "c", shop, state: state({ exp: 1 }) }), "shopify_expired"],
    ["an invalid shop", () => signedCallback({ code: "c", shop: "evil.com", state: state() }), "shopify_invalid_shop"],
  ])("refuses %s without exchanging the code", async (_name, build, code) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await GET(build());
    expect(response.headers.get("location")).toBe(
      `https://app.example.test/settings/integrations?business=error&provider=shopify&code=${code}`,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.storeErpConnection).not.toHaveBeenCalled();
  });

  it("signs sorted params excluding hmac and compares in constant time", () => {
    const params = new URLSearchParams("timestamp=2&shop=a.myshopify.com&code=x");
    const digest = createHmac("sha256", "k").update("code=x&shop=a.myshopify.com&timestamp=2").digest("hex");
    params.set("hmac", digest);
    expect(verifyShopifyHmac(params, "k")).toBe(true);
    params.set("hmac", digest.slice(0, 10));
    expect(verifyShopifyHmac(params, "k")).toBe(false);
    params.set("hmac", digest);
    params.set("shop", "b.myshopify.com");
    expect(verifyShopifyHmac(params, "k")).toBe(false);
  });
});
