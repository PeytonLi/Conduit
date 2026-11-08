import { createHash, createHmac } from "node:crypto";
import { deriveScopedKey, signScopedState, verifyScopedState } from "@/lib/integrations/gmail/crypto";
import type { StateVerifyError } from "@/lib/integrations/gmail/oauth";
import {
  MICROSOFT_LOGIN_BASE_URL,
  OUTLOOK_REQUIRED_SCOPES,
  OUTLOOK_SCOPES,
  type OutlookConfig,
} from "./config";
import { toGraphApiError, type FetchLike } from "./http";
import {
  outlookStatePayloadSchema,
  tokenResponseSchema,
  type OutlookStatePayload,
} from "./schemas";

const STATE_SCOPE = "outlook-oauth-state";
const PKCE_SCOPE = "outlook-oauth-pkce";

export function outlookTokenUrl(tenant: string): string {
  return `${MICROSOFT_LOGIN_BASE_URL}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
}

export function outlookAuthorizeUrl(tenant: string): string {
  return `${MICROSOFT_LOGIN_BASE_URL}/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize`;
}

export function createOutlookState({
  orgId,
  userId,
  nonce,
  redirectUri,
  signingKey,
  now,
}: {
  orgId: string;
  userId: string;
  nonce: string;
  redirectUri: string;
  signingKey: string;
  now: () => Date;
}): string {
  const payload: OutlookStatePayload = {
    o: orgId,
    u: userId,
    n: nonce,
    r: redirectUri,
    p: "outlook",
    exp: Math.floor(now().getTime() / 1000) + 600,
  };
  return signScopedState(STATE_SCOPE, payload, signingKey);
}

/**
 * Checks the callback state against the signed-in owner. The state is bound to
 * the organization, user, redirect URI and provider, and to a nonce that must
 * also arrive in an HttpOnly cookie set by the connect request.
 */
export function verifyOutlookCallback({
  state,
  nonceCookie,
  sessionUserId,
  sessionOrgId,
  sessionRole,
  redirectUri,
  signingKey,
  now,
}: {
  state: string;
  nonceCookie: string;
  sessionUserId: string;
  sessionOrgId: string;
  sessionRole: string;
  redirectUri: string;
  signingKey: string;
  now: () => Date;
}): { ok: true; orgId: string; userId: string; nonce: string } | { ok: false; error: StateVerifyError } {
  const verified = verifyScopedState(STATE_SCOPE, state, signingKey);
  if (!verified.ok) return { ok: false, error: verified.error };
  const parsed = outlookStatePayloadSchema.safeParse(verified.payload);
  if (!parsed.success) return { ok: false, error: "malformed" };
  const p = parsed.data;
  if (p.exp * 1000 < now().getTime()) return { ok: false, error: "expired" };
  if (!nonceCookie || p.n !== nonceCookie) return { ok: false, error: "nonce_mismatch" };
  if (p.u !== sessionUserId) return { ok: false, error: "user_mismatch" };
  if (p.o !== sessionOrgId) return { ok: false, error: "org_mismatch" };
  if (sessionRole !== "owner") return { ok: false, error: "not_owner" };
  if (p.r !== redirectUri) return { ok: false, error: "redirect_mismatch" };
  return { ok: true, orgId: p.o, userId: p.u, nonce: p.n };
}

function base64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

/**
 * PKCE verifier derived from the nonce with a server-only key. The browser
 * only ever sees the S256 challenge, and no extra cookie or table is needed.
 */
export function pkceVerifier(nonce: string, signingKey: string): string {
  return base64url(createHmac("sha256", deriveScopedKey(signingKey, PKCE_SCOPE)).update(nonce).digest());
}

export function pkceChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

export function buildOutlookAuthorizationUrl({
  config,
  state,
  nonce,
}: {
  config: OutlookConfig;
  state: string;
  nonce: string;
}): string {
  const url = new URL(outlookAuthorizeUrl(config.tenant));
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", OUTLOOK_SCOPES.join(" "));
  url.searchParams.set("state", state);
  // Without this, single sign-on silently reuses the signed-in Microsoft
  // account and a second mailbox could never be added.
  url.searchParams.set("prompt", "select_account");
  url.searchParams.set("code_challenge", pkceChallenge(pkceVerifier(nonce, config.signingKey)));
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export interface OutlookTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scopes: string[];
}

function normalizeScopes(scope: string | undefined): string[] {
  return (scope ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((s) => s.replace(/^https:\/\/graph\.microsoft\.com\//i, ""));
}

async function tokenRequest(
  config: OutlookConfig,
  fetchImpl: FetchLike,
  form: Record<string, string>,
  now: () => Date,
): Promise<{ accessToken: string; refreshToken: string | undefined; expiresAt: Date; scopes: string[] }> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    ...form,
  });
  const response = await fetchImpl(outlookTokenUrl(config.tenant), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
  });
  if (!response.ok) throw await toGraphApiError(response);
  const parsed = tokenResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("Microsoft returned an unexpected token response");
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    expiresAt: new Date(now().getTime() + parsed.data.expires_in * 1000),
    scopes: normalizeScopes(parsed.data.scope),
  };
}

export async function exchangeOutlookCode({
  config,
  code,
  verifier,
  fetchImpl,
  now = () => new Date(),
}: {
  config: OutlookConfig;
  code: string;
  verifier: string;
  fetchImpl: FetchLike;
  now?: () => Date;
}): Promise<OutlookTokens> {
  const token = await tokenRequest(
    config,
    fetchImpl,
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
      code_verifier: verifier,
      scope: OUTLOOK_SCOPES.join(" "),
    },
    now,
  );
  if (!token.refreshToken) throw new Error("Microsoft did not return a refresh token");
  const granted = new Set(token.scopes.map((s) => s.toLowerCase()));
  for (const required of OUTLOOK_REQUIRED_SCOPES) {
    if (!granted.has(required.toLowerCase())) {
      throw new Error(`Required Outlook scope not granted: ${required}`);
    }
  }
  return {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: token.expiresAt,
    scopes: token.scopes,
  };
}

export interface RefreshedAccessToken {
  accessToken: string;
  /** Microsoft rotates refresh tokens; this is the one to keep. */
  refreshToken: string;
  expiresAt: Date;
}

export async function refreshOutlookAccessToken({
  config,
  refreshToken,
  fetchImpl,
  now = () => new Date(),
}: {
  config: OutlookConfig;
  refreshToken: string;
  fetchImpl: FetchLike;
  now?: () => Date;
}): Promise<RefreshedAccessToken> {
  const token = await tokenRequest(
    config,
    fetchImpl,
    {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: OUTLOOK_SCOPES.join(" "),
    },
    now,
  );
  return {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken ?? refreshToken,
    expiresAt: token.expiresAt,
  };
}
