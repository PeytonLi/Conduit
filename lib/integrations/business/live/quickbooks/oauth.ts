import { QBO_AUTHORIZE_URL, QBO_SCOPE, QBO_TOKEN_URL } from "./config";
import { qboTokenResponseSchema, type QboTokenResponse } from "./schemas";

export class QboAuthError extends Error {
  constructor(
    readonly code: "invalid_grant" | "token_request_failed" | "bad_token_response",
    message: string,
  ) {
    super(message);
    this.name = "QboAuthError";
  }
}

export function buildQboAuthorizationUrl(input: { clientId: string; redirectUri: string; state: string }): string {
  const url = new URL(QBO_AUTHORIZE_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", QBO_SCOPE);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  return url.toString();
}

async function tokenRequest(
  body: Record<string, string>,
  client: { clientId: string; clientSecret: string },
  fetcher: typeof fetch,
): Promise<QboTokenResponse> {
  const basic = Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64");
  const response = await fetcher(QBO_TOKEN_URL, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body).toString(),
  });
  const json = (await response.json().catch(() => null)) as { error?: unknown } | null;
  if (!response.ok) {
    if (json?.error === "invalid_grant") throw new QboAuthError("invalid_grant", "QuickBooks rejected the grant; reconnect QuickBooks");
    throw new QboAuthError("token_request_failed", `QuickBooks token request failed with HTTP ${response.status}`);
  }
  const parsed = qboTokenResponseSchema.safeParse(json);
  if (!parsed.success) throw new QboAuthError("bad_token_response", "QuickBooks returned an unexpected token response");
  return parsed.data;
}

export function exchangeQboCode(
  input: { code: string; redirectUri: string; clientId: string; clientSecret: string },
  fetcher: typeof fetch = fetch,
): Promise<QboTokenResponse> {
  return tokenRequest({ grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri }, input, fetcher);
}

/** Intuit may return a different refresh_token on any refresh; callers must persist it. */
export function refreshQboToken(
  input: { refreshToken: string; clientId: string; clientSecret: string },
  fetcher: typeof fetch = fetch,
): Promise<QboTokenResponse> {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: input.refreshToken }, input, fetcher);
}

export function credentialsFromTokens(
  tokens: QboTokenResponse,
  base: { realm_id: string; environment: "sandbox" | "production" },
  now: Date,
) {
  return {
    provider: "quickbooks" as const,
    realm_id: base.realm_id,
    environment: base.environment,
    refresh_token: tokens.refresh_token,
    refresh_token_expires_at: tokens.x_refresh_token_expires_in
      ? new Date(now.getTime() + tokens.x_refresh_token_expires_in * 1000).toISOString()
      : null,
    access_token: tokens.access_token,
    access_token_expires_at: new Date(now.getTime() + tokens.expires_in * 1000).toISOString(),
  };
}
