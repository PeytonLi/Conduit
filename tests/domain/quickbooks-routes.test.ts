// MOCKED: Intuit's token endpoint and Conduit's connection storage are stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGmailState } from "@/lib/integrations/gmail/oauth";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => {
  class ErpNotConfiguredError extends Error {}
  return {
    requireMembership: vi.fn(),
    storeErpConnection: vi.fn(),
    AuthorizationError: class extends Error {},
    ErpNotConfiguredError,
  };
});

vi.mock("@/lib/auth/membership", () => ({
  requireMembership: mocks.requireMembership,
  AuthenticationError: class extends Error {},
  AuthorizationError: mocks.AuthorizationError,
}));

vi.mock("@/lib/integrations/business/live/connections", () => ({
  storeErpConnection: mocks.storeErpConnection,
  ErpNotConfiguredError: mocks.ErpNotConfiguredError,
}));

import { POST as connectPost } from "@/app/api/auth/quickbooks/connect/route";
import { GET as callback } from "@/app/api/auth/quickbooks/callback/route";

const signingKey = `v1:${Buffer.alloc(32, 7).toString("base64")}`;
const membership = { orgId: "org-1", userId: "user-1", role: "owner" };
const redirectUri = "https://app.example.test/api/auth/quickbooks/callback";

function state(overrides: Partial<Parameters<typeof createGmailState>[0]> = {}) {
  return createGmailState({ orgId: "org-1", userId: "user-1", nonce: "n-1", redirectUri, signingKey, now: () => new Date(), ...overrides });
}

function callbackRequest(params: Record<string, string>, cookie = "quickbooks_oauth_nonce=n-1") {
  return new Request(`${redirectUri}?${new URLSearchParams(params)}`, { headers: { cookie } });
}

function errorCode(response: Response) {
  const params = new URL(response.headers.get("location")!).searchParams;
  expect(params.get("provider")).toBe("quickbooks");
  return params.get("code");
}

describe("QuickBooks OAuth routes", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubEnv("APP_BASE_URL", "https://app.example.test");
    vi.stubEnv("QBO_CLIENT_ID", "qbo-client");
    vi.stubEnv("QBO_CLIENT_SECRET", "qbo-secret");
    vi.stubEnv("QBO_ENVIRONMENT", "sandbox");
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", signingKey);
    vi.stubGlobal("fetch", fetchMock);
    mocks.requireMembership.mockResolvedValue(membership);
    mocks.storeErpConnection.mockResolvedValue({ connectionId: "conn-1" });
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ token_type: "bearer", access_token: "at", refresh_token: "rt", expires_in: 3600, x_refresh_token_expires_in: 8726400 }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("returns an Intuit authorization URL with signed, org-scoped state", async () => {
    const response = await connectPost(new Request("https://app.example.test/api/auth/quickbooks/connect", { method: "POST" }));
    expect(response.status).toBe(200);
    const url = new URL((await response.json()).data.authorization_url);
    expect(url.origin + url.pathname).toBe("https://appcenter.intuit.com/connect/oauth2");
    expect(url.searchParams.get("scope")).toBe("com.intuit.quickbooks.accounting");
    expect(url.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(url.searchParams.get("client_id")).toBe("qbo-client");
    const payload = JSON.parse(Buffer.from(url.searchParams.get("state")!.split(".")[0], "base64url").toString());
    expect(payload).toMatchObject({ o: "org-1", u: "user-1", r: redirectUri });
    expect(response.headers.get("set-cookie")).toContain(`quickbooks_oauth_nonce=${payload.n}`);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly; Secure; SameSite=Lax");
    expect(mocks.requireMembership).toHaveBeenCalledWith(["owner"]);
  });

  it("is not configured without QBO credentials", async () => {
    vi.stubEnv("QBO_CLIENT_SECRET", "");
    const response = await connectPost(new Request("https://app.example.test/api/auth/quickbooks/connect", { method: "POST" }));
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("quickbooks_not_configured");
    const back = await callback(callbackRequest({ state: state(), code: "c", realmId: "123" }));
    expect(errorCode(back)).toBe("quickbooks_not_configured");
  });

  it("rejects non-owners", async () => {
    mocks.requireMembership.mockRejectedValue(new mocks.AuthorizationError("owner only"));
    const response = await connectPost(new Request("https://app.example.test/api/auth/quickbooks/connect", { method: "POST" }));
    expect(response.status).toBe(403);
  });

  it("exchanges the code and stores the realm and rotated tokens", async () => {
    const response = await callback(callbackRequest({ state: state(), code: "auth-code", realmId: "9341453000000000" }));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://app.example.test/settings/integrations?business=connected&provider=quickbooks");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    const [tokenUrl, init] = fetchMock.mock.calls[0];
    expect(tokenUrl).toBe("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer");
    expect(init.headers.authorization).toBe(`Basic ${Buffer.from("qbo-client:qbo-secret").toString("base64")}`);
    expect(Object.fromEntries(new URLSearchParams(init.body))).toEqual({ grant_type: "authorization_code", code: "auth-code", redirect_uri: redirectUri });
    expect(mocks.storeErpConnection).toHaveBeenCalledWith({
      orgId: "org-1",
      actorUserId: "user-1",
      provider: "quickbooks",
      externalAccountId: "9341453000000000",
      scopes: ["com.intuit.quickbooks.accounting"],
      credentials: expect.objectContaining({ provider: "quickbooks", realm_id: "9341453000000000", environment: "sandbox", refresh_token: "rt", access_token: "at" }),
      expiresAt: expect.any(String),
    });
  });

  it.each([
    ["nonce_mismatch", { state: state() }, "quickbooks_oauth_nonce=other"],
    ["org_mismatch", { state: state({ orgId: "org-2" }) }, undefined],
    ["user_mismatch", { state: state({ userId: "user-2" }) }, undefined],
    ["redirect_mismatch", { state: state({ redirectUri: "https://evil.test/cb" }) }, undefined],
    ["bad_signature", { state: `${state().split(".")[0]}.AAAA` }, undefined],
    ["consent_denied", { state: state(), error: "access_denied" }, undefined],
    ["missing_code", { state: state(), realmId: "1" }, undefined],
    ["missing_realm", { state: state(), code: "c", realmId: "abc" }, undefined],
  ])("rejects %s without storing anything", async (code, params, cookie) => {
    const response = await callback(callbackRequest(params as Record<string, string>, cookie));
    expect(errorCode(response)).toBe(code);
    expect(mocks.storeErpConnection).not.toHaveBeenCalled();
  });

  it("reports a failed token exchange", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    expect(errorCode(await callback(callbackRequest({ state: state(), code: "c", realmId: "1" })))).toBe("exchange_failed");
    expect(mocks.storeErpConnection).not.toHaveBeenCalled();
  });

  it("maps a storage not-configured error", async () => {
    mocks.storeErpConnection.mockRejectedValue(new mocks.ErpNotConfiguredError("no key"));
    expect(errorCode(await callback(callbackRequest({ state: state(), code: "c", realmId: "1" })))).toBe("quickbooks_not_configured");
  });
});
