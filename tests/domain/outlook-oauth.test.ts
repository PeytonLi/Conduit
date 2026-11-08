import { describe, expect, it, vi } from "vitest";
import { createGmailState } from "@/lib/integrations/gmail/oauth";
import { OUTLOOK_SCOPES, outlookConfig, outlookPollEnabled } from "@/lib/integrations/outlook/config";
import {
  createMicrosoftFetch,
  MicrosoftReplayViolationError,
  classifyOutlookError,
  GraphApiError,
} from "@/lib/integrations/outlook/http";
import {
  buildOutlookAuthorizationUrl,
  createOutlookState,
  exchangeOutlookCode,
  pkceChallenge,
  pkceVerifier,
  refreshOutlookAccessToken,
  verifyOutlookCallback,
} from "@/lib/integrations/outlook/oauth";
import { parseOutlookCredential, serializeOutlookCredential } from "@/lib/integrations/outlook/credentials";

const signingKey = `v1:${Buffer.alloc(32, 9).toString("base64")}`;
const ORG = "00000000-0000-4000-8000-0000000000a1";
const USER = "00000000-0000-4000-8000-0000000000b1";
const REDIRECT = "https://app.example.test/api/auth/outlook/callback";
const NOW = new Date("2026-11-08T20:00:00Z");

const config = outlookConfig({
  MICROSOFT_CLIENT_ID: "client-id",
  MICROSOFT_CLIENT_SECRET: "client-secret",
  MICROSOFT_REDIRECT_URI: REDIRECT,
  CREDENTIAL_ENCRYPTION_KEY: signingKey,
})!;

function state(overrides: Partial<Parameters<typeof createOutlookState>[0]> = {}) {
  return createOutlookState({
    orgId: ORG,
    userId: USER,
    nonce: "nonce-1",
    redirectUri: REDIRECT,
    signingKey,
    now: () => NOW,
    ...overrides,
  });
}

function verify(
  stateValue: string,
  overrides: Partial<Parameters<typeof verifyOutlookCallback>[0]> = {},
) {
  return verifyOutlookCallback({
    state: stateValue,
    nonceCookie: "nonce-1",
    sessionUserId: USER,
    sessionOrgId: ORG,
    sessionRole: "owner",
    redirectUri: REDIRECT,
    signingKey,
    now: () => NOW,
    ...overrides,
  });
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("Outlook OAuth state", () => {
  it("accepts a state bound to the same owner, organization, redirect and nonce", () => {
    expect(verify(state())).toMatchObject({ ok: true, orgId: ORG, userId: USER, nonce: "nonce-1" });
  });

  it.each([
    ["nonce_mismatch", { nonceCookie: "other" }],
    ["nonce_mismatch", { nonceCookie: "" }],
    ["user_mismatch", { sessionUserId: "00000000-0000-4000-8000-0000000000b2" }],
    ["org_mismatch", { sessionOrgId: "00000000-0000-4000-8000-0000000000a2" }],
    ["not_owner", { sessionRole: "operator" }],
    ["redirect_mismatch", { redirectUri: "https://evil.example/cb" }],
  ] as const)("rejects with %s", (error, override) => {
    expect(verify(state(), override)).toEqual({ ok: false, error });
  });

  it("rejects an expired state against the injected clock", () => {
    expect(verify(state(), { now: () => new Date(NOW.getTime() + 601_000) })).toEqual({
      ok: false,
      error: "expired",
    });
  });

  it("rejects a tampered or foreign-keyed state", () => {
    const good = state();
    const [body, sig] = good.split(".");
    const forgedBody = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), o: "x" }),
    ).toString("base64url");
    expect(verify(`${forgedBody}.${sig}`)).toEqual({ ok: false, error: "bad_signature" });
    expect(verify("not-a-state")).toEqual({ ok: false, error: "malformed" });
    const otherKey = `v1:${Buffer.alloc(32, 3).toString("base64")}`;
    expect(verify(state({ signingKey: otherKey }))).toEqual({ ok: false, error: "bad_signature" });
  });

  it("does not accept a Gmail-signed state, even with matching fields", () => {
    const gmail = createGmailState({
      orgId: ORG,
      userId: USER,
      nonce: "nonce-1",
      redirectUri: REDIRECT,
      signingKey,
      now: () => NOW,
    });
    expect(verify(gmail)).toEqual({ ok: false, error: "bad_signature" });
  });
});

describe("Outlook authorization request", () => {
  it("asks for offline mail access with PKCE and an account chooser", () => {
    const url = new URL(
      buildOutlookAuthorizationUrl({ config, state: state(), nonce: "nonce-1" }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([...OUTLOOK_SCOPES]);
    // Without select_account a second mailbox could never be chosen.
    expect(url.searchParams.get("prompt")).toBe("select_account");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(
      pkceChallenge(pkceVerifier("nonce-1", signingKey)),
    );
    expect(url.searchParams.get("state")).toBe(state());
    expect(url.toString()).not.toContain("client-secret");
    expect(url.toString()).not.toContain(pkceVerifier("nonce-1", signingKey));
  });

  it("derives a different verifier per nonce and per key", () => {
    expect(pkceVerifier("a", signingKey)).not.toBe(pkceVerifier("b", signingKey));
    expect(pkceVerifier("a", signingKey)).not.toBe(
      pkceVerifier("a", `v1:${Buffer.alloc(32, 4).toString("base64")}`),
    );
    expect(pkceVerifier("a", signingKey)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("uses the configured tenant", () => {
    const tenanted = { ...config, tenant: "contoso.onmicrosoft.com" };
    expect(buildOutlookAuthorizationUrl({ config: tenanted, state: "s", nonce: "n" })).toContain(
      "/contoso.onmicrosoft.com/oauth2/v2.0/authorize",
    );
  });
});

describe("Outlook code exchange and refresh", () => {
  const tokenBody = {
    access_token: "access-1",
    refresh_token: "refresh-1",
    expires_in: 3600,
    scope: "Mail.ReadWrite Mail.Send User.Read",
    token_type: "Bearer",
  };

  it("posts the code with the PKCE verifier and returns validated tokens", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return jsonResponse(tokenBody);
    };
    const tokens = await exchangeOutlookCode({
      config,
      code: "auth-code",
      verifier: "verifier-1",
      fetchImpl,
      now: () => NOW,
    });
    const { url, init } = requests[0];
    expect(url).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token");
    const form = new URLSearchParams(String(init?.body));
    expect(Object.fromEntries(form)).toMatchObject({
      grant_type: "authorization_code",
      code: "auth-code",
      code_verifier: "verifier-1",
      redirect_uri: REDIRECT,
      client_id: "client-id",
    });
    expect(tokens).toMatchObject({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: new Date(NOW.getTime() + 3_600_000),
    });
  });

  it("accepts Graph scopes reported with their URL prefix", async () => {
    const fetchImpl = async () =>
      jsonResponse({
        ...tokenBody,
        scope:
          "https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send openid",
      });
    await expect(
      exchangeOutlookCode({ config, code: "c", verifier: "v", fetchImpl }),
    ).resolves.toMatchObject({ refreshToken: "refresh-1" });
  });

  it("refuses a connection without a refresh token or without send access", async () => {
    await expect(
      exchangeOutlookCode({
        config,
        code: "c",
        verifier: "v",
        fetchImpl: async () => jsonResponse({ ...tokenBody, refresh_token: undefined }),
      }),
    ).rejects.toThrow("refresh token");
    await expect(
      exchangeOutlookCode({
        config,
        code: "c",
        verifier: "v",
        fetchImpl: async () => jsonResponse({ ...tokenBody, scope: "Mail.ReadWrite User.Read" }),
      }),
    ).rejects.toThrow("Mail.Send");
  });

  it("rejects a malformed token response at the boundary", async () => {
    await expect(
      exchangeOutlookCode({
        config,
        code: "c",
        verifier: "v",
        fetchImpl: async () => jsonResponse({ access_token: "", expires_in: "soon" }),
      }),
    ).rejects.toThrow("unexpected token response");
  });

  it("surfaces an invalid_grant refusal as a revoked connection without leaking the body", async () => {
    const error = await refreshOutlookAccessToken({
      config,
      refreshToken: "dead",
      fetchImpl: async () =>
        jsonResponse(
          { error: "invalid_grant", error_description: "AADSTS70008: secret detail" },
          400,
        ),
    }).catch((e) => e);
    expect(error).toBeInstanceOf(GraphApiError);
    expect(classifyOutlookError(error)).toBe("revoked");
    expect(String(error.message)).not.toContain("secret detail");
  });

  it("keeps the old refresh token when Microsoft does not rotate it, and takes a new one when it does", async () => {
    const noRotation = await refreshOutlookAccessToken({
      config,
      refreshToken: "old",
      fetchImpl: async () => jsonResponse({ ...tokenBody, refresh_token: undefined }),
      now: () => NOW,
    });
    expect(noRotation.refreshToken).toBe("old");
    const rotated = await refreshOutlookAccessToken({
      config,
      refreshToken: "old",
      fetchImpl: async () => jsonResponse({ ...tokenBody, refresh_token: "new" }),
      now: () => NOW,
    });
    expect(rotated.refreshToken).toBe("new");
  });
});

describe("Outlook credential, configuration and replay guard", () => {
  it("round-trips a credential and rejects other shapes", () => {
    const text = serializeOutlookCredential({ provider: "outlook", refreshToken: "r" });
    expect(parseOutlookCredential(text)).toEqual({ provider: "outlook", refreshToken: "r" });
    expect(() => parseOutlookCredential(JSON.stringify({ provider: "google", refreshToken: "r" }))).toThrow();
    expect(() => parseOutlookCredential("plain-token")).toThrow();
  });

  it("needs the app registration and the encryption key", () => {
    expect(outlookConfig({})).toBeNull();
    expect(
      outlookConfig({
        MICROSOFT_CLIENT_ID: "a",
        MICROSOFT_CLIENT_SECRET: "b",
        MICROSOFT_REDIRECT_URI: REDIRECT,
      }),
    ).toBeNull();
    expect(config.tenant).toBe("common");
  });

  it("never polls in replay", () => {
    const configured = {
      MICROSOFT_CLIENT_ID: "a",
      MICROSOFT_CLIENT_SECRET: "b",
      MICROSOFT_REDIRECT_URI: REDIRECT,
      CREDENTIAL_ENCRYPTION_KEY: signingKey,
    };
    expect(outlookPollEnabled({ ...configured, APP_ENV: "replay" })).toBe(false);
    expect(outlookPollEnabled({ ...configured, APP_ENV: "sandbox" })).toBe(true);
    expect(outlookPollEnabled({ APP_ENV: "live" })).toBe(false);
  });

  it("throws before any network I/O in replay, and reads the mode on every call", async () => {
    const underlying = vi.fn(async () => jsonResponse({}));
    let mode: "replay" | "sandbox" = "replay";
    const guarded = createMicrosoftFetch({ appEnv: () => mode, fetchImpl: underlying });
    await expect(guarded("https://graph.microsoft.com/v1.0/me")).rejects.toBeInstanceOf(
      MicrosoftReplayViolationError,
    );
    expect(underlying).not.toHaveBeenCalled();
    mode = "sandbox";
    await guarded("https://graph.microsoft.com/v1.0/me");
    expect(underlying).toHaveBeenCalledTimes(1);
  });

  it("classifies provider errors like the Gmail path", () => {
    expect(classifyOutlookError(new GraphApiError(410, "syncStateNotFound"))).toBe("invalid_cursor");
    expect(classifyOutlookError(new GraphApiError(401, "InvalidAuthenticationToken"))).toBe("expired");
    expect(classifyOutlookError(new GraphApiError(429, "ApplicationThrottled"))).toBe("rate_limited");
    expect(classifyOutlookError(new GraphApiError(503, null))).toBe("transient");
    expect(classifyOutlookError(new GraphApiError(403, "ErrorAccessDenied"))).toBe("invalid_request");
    expect(classifyOutlookError(new TypeError("fetch failed"))).toBe("transient");
  });
});
