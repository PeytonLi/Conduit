import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  rpc: vi.fn(),
  AuthorizationError: class extends Error {},
  AuthenticationError: class extends Error {},
}));

vi.mock("@/lib/auth/membership", () => ({
  requireMembership: mocks.requireMembership,
  AuthenticationError: mocks.AuthenticationError,
  AuthorizationError: mocks.AuthorizationError,
}));
vi.mock("@/lib/db/service", () => ({
  createServiceClient: () => ({
    rpc: async (fn: string, args: { p: Record<string, unknown> }) => ({
      data: mocks.rpc(fn, args.p) ?? null,
      error: null,
    }),
  }),
}));

import { POST as connect } from "@/app/api/auth/outlook/connect/route";
import { GET as callback } from "@/app/api/auth/outlook/callback/route";
import { DELETE as disconnectMailbox } from "@/app/api/v1/connections/mailboxes/[connectionId]/route";
import { POST as makePrimary } from "@/app/api/v1/connections/mailboxes/[connectionId]/primary/route";
import { decryptCredential } from "@/lib/integrations/gmail/crypto";
import { createOutlookState, pkceChallenge, pkceVerifier } from "@/lib/integrations/outlook/oauth";

const signingKey = `v1:${Buffer.alloc(32, 7).toString("base64")}`;
const REDIRECT = "https://app.example.test/api/auth/outlook/callback";
const membership = {
  orgId: "00000000-0000-4000-8000-0000000000a1",
  userId: "00000000-0000-4000-8000-0000000000b1",
  role: "owner",
};

function stubEnv(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    APP_BASE_URL: "https://app.example.test",
    APP_ENV: "sandbox",
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_PUBLISHABLE_KEY: "p",
    SUPABASE_SECRET_KEY: "s",
    CREDENTIAL_ENCRYPTION_KEY: signingKey,
    MICROSOFT_CLIENT_ID: "client-id",
    MICROSOFT_CLIENT_SECRET: "client-secret",
    MICROSOFT_REDIRECT_URI: REDIRECT,
    ...overrides,
  };
  for (const [k, v] of Object.entries(values)) vi.stubEnv(k, v);
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const tokenBody = {
  access_token: "access-1",
  refresh_token: "refresh-1",
  expires_in: 3600,
  scope: "Mail.ReadWrite Mail.Send User.Read",
};

function stubMicrosoft(over: { token?: Response; me?: Response } = {}) {
  const calls: { url: string; body: string }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: String(init?.body ?? "") });
    if (url.includes("login.microsoftonline.com")) return over.token ?? json(tokenBody);
    return over.me ?? json({ mail: "Buyer@Harbor.Example" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

function callbackRequest(options: { state?: string; nonce?: string; query?: string } = {}) {
  const state =
    options.state ??
    createOutlookState({
      orgId: membership.orgId,
      userId: membership.userId,
      nonce: "n1",
      redirectUri: REDIRECT,
      signingKey,
      now: () => new Date(),
    });
  const query = options.query ?? `code=auth-code&state=${encodeURIComponent(state)}`;
  return new Request(`${REDIRECT}?${query}`, {
    headers: { cookie: `outlook_oauth_nonce=${options.nonce ?? "n1"}` },
  });
}

const errorCode = (response: Response) =>
  new URL(response.headers.get("location")!).searchParams.get("code");

beforeEach(() => {
  stubEnv();
  mocks.requireMembership.mockResolvedValue(membership);
  mocks.rpc.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("POST /api/auth/outlook/connect", () => {
  it("returns a Microsoft consent URL bound to the owner, with PKCE and a nonce cookie", async () => {
    const response = await connect();
    expect(response.status).toBe(200);
    const url = new URL((await response.json()).data.authorization_url);
    expect(url.origin + url.pathname).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    const cookie = response.headers.get("set-cookie")!;
    const nonce = cookie.match(/outlook_oauth_nonce=([^;]+)/)![1];
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/api/auth/outlook");
    expect(url.searchParams.get("code_challenge")).toBe(pkceChallenge(pkceVerifier(nonce, signingKey)));
    expect(mocks.requireMembership).toHaveBeenCalledWith(["owner"]);
  });

  it("refuses in replay without issuing a URL or cookie", async () => {
    vi.stubEnv("APP_ENV", "replay");
    const response = await connect();
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("outlook_unavailable_in_replay");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("reports missing configuration", async () => {
    vi.stubEnv("MICROSOFT_CLIENT_SECRET", "");
    const response = await connect();
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("outlook_not_configured");
  });

  it("rejects a non-owner", async () => {
    mocks.requireMembership.mockRejectedValue(new mocks.AuthorizationError());
    expect((await connect()).status).toBe(403);
  });
});

describe("GET /api/auth/outlook/callback", () => {
  it("stores the mailbox as a new connection with an encrypted credential", async () => {
    const ms = stubMicrosoft();
    const response = await callback(callbackRequest());

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://app.example.test/settings/integrations?outlook=connected",
    );
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");

    const tokenRequest = new URLSearchParams(ms.calls[0].body);
    expect(tokenRequest.get("code")).toBe("auth-code");
    expect(tokenRequest.get("code_verifier")).toBe(pkceVerifier("n1", signingKey));

    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = mocks.rpc.mock.calls[0];
    expect(fn).toBe("mailbox_store_connection");
    expect(args).toMatchObject({
      org_id: membership.orgId,
      actor_user_id: membership.userId,
      provider: "outlook",
      external_account_id: "buyer@harbor.example",
      capabilities: { mail_read: true, mail_send: true },
      key_version: "v1",
    });
    expect(JSON.parse(decryptCredential(args.encrypted_b64, signingKey, "v1"))).toEqual({
      provider: "outlook",
      refreshToken: "refresh-1",
    });
    expect(JSON.stringify(args)).not.toContain("refresh-1");
    expect(JSON.stringify(args)).not.toContain("access-1");
  });

  it.each([
    ["a nonce cookie that does not match", { nonce: "other" }, "nonce_mismatch"],
    ["a state signed for another key", { state: "abc.def" }, "bad_signature"],
    ["a malformed state", { state: "garbage" }, "malformed"],
  ])("rejects %s before contacting Microsoft", async (_label, options, code) => {
    const ms = stubMicrosoft();
    const response = await callback(callbackRequest(options));
    expect(errorCode(response)).toBe(code);
    expect(ms.fetchMock).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rejects a state created for a different signed-in user", async () => {
    const ms = stubMicrosoft();
    const state = createOutlookState({
      orgId: membership.orgId,
      userId: "00000000-0000-4000-8000-0000000000b2",
      nonce: "n1",
      redirectUri: REDIRECT,
      signingKey,
      now: () => new Date(),
    });
    expect(errorCode(await callback(callbackRequest({ state })))).toBe("user_mismatch");
    expect(ms.fetchMock).not.toHaveBeenCalled();
  });

  it("is unavailable in replay and never reaches Microsoft", async () => {
    vi.stubEnv("APP_ENV", "replay");
    const ms = stubMicrosoft();
    expect(errorCode(await callback(callbackRequest()))).toBe("outlook_unavailable_in_replay");
    expect(ms.fetchMock).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("maps a denied consent and a missing code to readable errors", async () => {
    const ms = stubMicrosoft();
    const state = encodeURIComponent("x.y");
    expect(errorCode(await callback(callbackRequest({ query: `error=access_denied&state=${state}` })))).toBe("access_denied");
    expect(errorCode(await callback(callbackRequest({ query: `error=server_error&state=${state}` })))).toBe("connection_failed");
    expect(errorCode(await callback(callbackRequest({ query: `state=${state}` })))).toBe("missing_code");
    expect(errorCode(await callback(callbackRequest({ query: "code=c" })))).toBe("malformed");
    expect(ms.fetchMock).not.toHaveBeenCalled();
  });

  it("stores nothing when the exchange fails or send access was not granted", async () => {
    stubMicrosoft({ token: json({ error: "invalid_grant" }, 400) });
    expect(errorCode(await callback(callbackRequest()))).toBe("exchange_failed");
    stubMicrosoft({ token: json({ ...tokenBody, scope: "Mail.ReadWrite User.Read" }) });
    expect(errorCode(await callback(callbackRequest()))).toBe("exchange_failed");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("stores nothing when the account cannot be verified", async () => {
    stubMicrosoft({ me: json({ error: { code: "Unauthorized" } }, 401) });
    expect(errorCode(await callback(callbackRequest()))).toBe("connection_verification_failed");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("sends a non-owner back with an unauthorized error", async () => {
    mocks.requireMembership.mockRejectedValue(new mocks.AuthorizationError());
    const ms = stubMicrosoft();
    expect(errorCode(await callback(callbackRequest()))).toBe("unauthorized");
    expect(ms.fetchMock).not.toHaveBeenCalled();
  });
});

describe("mailbox management routes", () => {
  const ID = "00000000-0000-4000-8000-0000000000c1";
  const headers = {
    origin: "https://app.example.test",
    host: "app.example.test",
  };
  const params = (connectionId: string) => ({ params: Promise.resolve({ connectionId }) });

  it("requires an Idempotency-Key on both mutations", async () => {
    const del = await disconnectMailbox(
      new Request(`https://app.example.test/api/v1/connections/mailboxes/${ID}`, { method: "DELETE", headers }),
      params(ID),
    );
    const primary = await makePrimary(
      new Request(`https://app.example.test/api/v1/connections/mailboxes/${ID}/primary`, { method: "POST", headers }),
      params(ID),
    );
    expect(del.status).toBe(422);
    expect(primary.status).toBe(422);
    expect(mocks.requireMembership).not.toHaveBeenCalled();
  });

  it("rejects a connection id that is not a UUID before any lookup", async () => {
    const response = await disconnectMailbox(
      new Request("https://app.example.test/api/v1/connections/mailboxes/nope", {
        method: "DELETE",
        headers: { ...headers, "idempotency-key": "k1" },
      }),
      params("nope"),
    );
    expect(response.status).toBe(422);
    expect(mocks.requireMembership).not.toHaveBeenCalled();
  });

  it("limits both mutations to owners", async () => {
    mocks.requireMembership.mockRejectedValue(new mocks.AuthorizationError());
    const request = (method: string, path = "") =>
      new Request(`https://app.example.test/api/v1/connections/mailboxes/${ID}${path}`, {
        method,
        headers: { ...headers, "idempotency-key": "k1" },
      });
    expect((await disconnectMailbox(request("DELETE"), params(ID))).status).toBe(403);
    expect((await makePrimary(request("POST", "/primary"), params(ID))).status).toBe(403);
    expect(mocks.requireMembership).toHaveBeenCalledWith(["owner"]);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
