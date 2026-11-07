import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGmailState } from "@/lib/integrations/gmail/oauth";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  storeErpConnection: vi.fn(),
  NotConfigured: class extends Error {},
}));

vi.mock("@/lib/auth/membership", () => ({
  requireMembership: mocks.requireMembership,
  AuthenticationError: class extends Error {},
  AuthorizationError: class extends Error {},
}));

vi.mock("@/lib/integrations/business/live/connections", () => ({
  storeErpConnection: mocks.storeErpConnection,
  ErpNotConfiguredError: mocks.NotConfigured,
}));

import { POST as connect } from "@/app/api/auth/zoho/connect/route";
import { GET as callback } from "@/app/api/auth/zoho/callback/route";

const signingKey = `v1:${Buffer.alloc(32, 7).toString("base64")}`;
const membership = { orgId: "org-1", userId: "user-1", role: "owner" };
const redirectUri = "https://app.example.test/api/auth/zoho/callback";

function state(nonce = "nonce-1", overrides: Partial<{ orgId: string; userId: string }> = {}) {
  return createGmailState({
    orgId: overrides.orgId ?? "org-1",
    userId: overrides.userId ?? "user-1",
    nonce,
    redirectUri,
    signingKey,
    now: () => new Date(),
  });
}

function callbackRequest(params: Record<string, string>, cookieNonce = "nonce-1") {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return new Request(url, { headers: { cookie: `zoho_oauth_nonce=${cookieNonce}` } });
}

const zohoFetch = vi.fn<typeof fetch>(async (input) => {
  const url = String(input);
  if (url === "https://accounts.zoho.eu/oauth/v2/token") {
    return Response.json({ access_token: "at", refresh_token: "rt", api_domain: "https://www.zohoapis.eu", token_type: "Bearer", expires_in: 3600 });
  }
  if (url === "https://www.zohoapis.eu/inventory/v1/organizations") {
    return Response.json({ code: 0, message: "success", organizations: [
      { organization_id: "111", name: "Other", is_default_org: false },
      { organization_id: "20012345", name: "Conduit Test Co", is_default_org: true },
    ] });
  }
  return Response.json({ code: 1, message: "unexpected" }, { status: 404 });
});

describe("Zoho OAuth routes (mocked Zoho)", () => {
  beforeEach(() => {
    vi.stubEnv("APP_BASE_URL", "https://app.example.test");
    vi.stubEnv("APP_ENV", "sandbox");
    vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "test-publishable-key");
    vi.stubEnv("SUPABASE_SECRET_KEY", "test-secret-key");
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", signingKey);
    vi.stubEnv("ZOHO_CLIENT_ID", "zoho-client");
    vi.stubEnv("ZOHO_CLIENT_SECRET", "zoho-secret");
    vi.stubEnv("ZOHO_REDIRECT_URI", "");
    vi.stubGlobal("fetch", zohoFetch);
    mocks.requireMembership.mockResolvedValue(membership);
    mocks.storeErpConnection.mockResolvedValue({ connectionId: "conn-1" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("returns a Zoho consent URL with Inventory scopes, offline access and signed state", async () => {
    const response = await connect(new Request("https://app.example.test/api/auth/zoho/connect", { method: "POST" }));
    expect(response.status).toBe(200);
    const location = new URL((await response.json()).data.authorization_url);
    expect(location.origin + location.pathname).toBe("https://accounts.zoho.com/oauth/v2/auth");
    expect(location.searchParams.get("client_id")).toBe("zoho-client");
    expect(location.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(location.searchParams.get("access_type")).toBe("offline");
    expect(location.searchParams.get("scope")).toContain("ZohoInventory.purchaseorders.UPDATE");
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(response.headers.get("set-cookie")).toMatch(/^zoho_oauth_nonce=[^;]+; Path=\/api\/auth\/zoho; HttpOnly; Secure/);
    expect(mocks.requireMembership).toHaveBeenCalledWith(["owner"]);
  });

  it("returns not configured without Zoho client credentials", async () => {
    vi.stubEnv("ZOHO_CLIENT_SECRET", "");
    const response = await connect(new Request("https://app.example.test/api/auth/zoho/connect", { method: "POST" }));
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("zoho_inventory_not_configured");
  });

  it("exchanges the code on the user's data center and stores the encrypted credential via storeErpConnection", async () => {
    const response = await callback(callbackRequest({
      state: state(), code: "grant", location: "eu", "accounts-server": "https://accounts.zoho.eu",
    }));
    expect(response.headers.get("location")).toBe(
      "https://app.example.test/settings/integrations?business=connected&provider=zoho_inventory",
    );
    const tokenCall = zohoFetch.mock.calls.find(([url]) => String(url).endsWith("/oauth/v2/token"))!;
    const form = new URLSearchParams(String(tokenCall[1]?.body));
    expect(form.get("redirect_uri")).toBe(redirectUri);
    expect(form.get("code")).toBe("grant");
    expect(mocks.storeErpConnection).toHaveBeenCalledWith(expect.objectContaining({
      orgId: "org-1",
      actorUserId: "user-1",
      provider: "zoho_inventory",
      externalAccountId: "20012345",
      expiresAt: null,
      credentials: {
        refresh_token: "rt",
        api_domain: "https://www.zohoapis.eu",
        accounts_server: "https://accounts.zoho.eu",
        organization_id: "20012345",
      },
    }));
  });

  it.each([
    ["nonce mismatch", { state: state(), code: "grant" }, "other-nonce", "nonce_mismatch"],
    ["another org's state", { state: state("nonce-1", { orgId: "org-2" }), code: "grant" }, "nonce-1", "org_mismatch"],
    ["untrusted accounts server", { state: state(), code: "grant", "accounts-server": "https://accounts.evil.io" }, "nonce-1", "unknown_data_center"],
    ["denied consent", { state: state(), error: "access_denied" }, "nonce-1", "consent_denied"],
  ])("rejects %s without storing anything", async (_name, params, cookie, code) => {
    const response = await callback(callbackRequest(params, cookie));
    expect(response.headers.get("location")).toContain(`business=error&provider=zoho_inventory&code=${code}`);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(mocks.storeErpConnection).not.toHaveBeenCalled();
  });

  it("maps a missing encryption key in storage to zoho_inventory_not_configured", async () => {
    mocks.storeErpConnection.mockRejectedValue(new mocks.NotConfigured("missing key"));
    const response = await callback(callbackRequest({
      state: state(), code: "grant", "accounts-server": "https://accounts.zoho.eu",
    }));
    expect(response.headers.get("location")).toContain("code=zoho_inventory_not_configured");
  });
});
