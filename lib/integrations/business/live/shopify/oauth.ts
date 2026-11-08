import { createHmac, hkdfSync, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ShopifyApiError, isShopDomain } from "./graphql";

/** write_* implies read_* for the same resource. */
export const SHOPIFY_SCOPES = [
  "read_locations",
  "read_products",
  "read_inventory",
  "read_merchant_managed_fulfillment_orders",
  "read_inventory_transfers",
  "write_inventory_shipments",
  "read_inventory_shipments_received_items",
] as const;

export const SHOPIFY_STATE_COOKIE = "shopify_oauth_nonce";
const STATE_TTL_SECONDS = 600;

export function normalizeShopDomain(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let value = input.trim().toLowerCase();
  value = value.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!value.includes(".")) value = `${value}.myshopify.com`;
  return isShopDomain(value) ? value : null;
}

function stateKey(key: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(key), "shopify-oauth-state", "state-signing", 32));
}

const statePayload = z.object({ o: z.string(), u: z.string(), n: z.string(), s: z.string(), exp: z.number().int() });
export type ShopifyStatePayload = z.infer<typeof statePayload>;

export function signShopifyState(payload: ShopifyStatePayload, signingKey: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", stateKey(signingKey)).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export type ShopifyCallbackError =
  | "malformed"
  | "bad_signature"
  | "bad_hmac"
  | "expired"
  | "nonce_mismatch"
  | "user_mismatch"
  | "org_mismatch"
  | "shop_mismatch"
  | "invalid_shop"
  | "missing_code";

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Shopify signs every callback query parameter except `hmac`, sorted by key. */
export function verifyShopifyHmac(params: URLSearchParams, clientSecret: string): boolean {
  const hmac = params.get("hmac");
  if (!hmac || !/^[0-9a-f]+$/i.test(hmac)) return false;
  const message = [...params.entries()]
    .filter(([k]) => k !== "hmac" && k !== "signature")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const digest = createHmac("sha256", clientSecret).update(message).digest("hex");
  return safeEqual(digest, hmac.toLowerCase());
}

export function createShopifyAuthorization(input: {
  shop: string;
  orgId: string;
  userId: string;
  clientId: string;
  redirectUri: string;
  signingKey: string;
  now: () => Date;
  nonce?: string;
}): { url: string; nonce: string } {
  const nonce = input.nonce ?? randomUUID();
  const state = signShopifyState(
    {
      o: input.orgId,
      u: input.userId,
      n: nonce,
      s: input.shop,
      exp: Math.floor(input.now().getTime() / 1000) + STATE_TTL_SECONDS,
    },
    input.signingKey,
  );
  const url = new URL(`https://${input.shop}/admin/oauth/authorize`);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("scope", SHOPIFY_SCOPES.join(","));
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", state);
  return { url: url.toString(), nonce };
}

export function verifyShopifyCallback(input: {
  params: URLSearchParams;
  nonceCookie: string;
  sessionOrgId: string;
  sessionUserId: string;
  clientSecret: string;
  signingKey: string;
  now: () => Date;
}): { ok: true; shop: string; code: string } | { ok: false; error: ShopifyCallbackError } {
  const { params } = input;
  if (!verifyShopifyHmac(params, input.clientSecret)) return { ok: false, error: "bad_hmac" };
  const shop = params.get("shop") ?? "";
  if (!isShopDomain(shop)) return { ok: false, error: "invalid_shop" };
  const [body, sig, extra] = (params.get("state") ?? "").split(".");
  if (!body || !sig || extra !== undefined) return { ok: false, error: "malformed" };
  const expected = createHmac("sha256", stateKey(input.signingKey)).update(body).digest("base64url");
  if (!safeEqual(expected, sig)) return { ok: false, error: "bad_signature" };
  let payload: ShopifyStatePayload;
  try {
    payload = statePayload.parse(JSON.parse(Buffer.from(body, "base64url").toString("utf8")));
  } catch {
    return { ok: false, error: "malformed" };
  }
  if (payload.exp < Math.floor(input.now().getTime() / 1000)) return { ok: false, error: "expired" };
  if (!input.nonceCookie || !safeEqual(payload.n, input.nonceCookie)) return { ok: false, error: "nonce_mismatch" };
  if (payload.u !== input.sessionUserId) return { ok: false, error: "user_mismatch" };
  if (payload.o !== input.sessionOrgId) return { ok: false, error: "org_mismatch" };
  if (payload.s !== shop) return { ok: false, error: "shop_mismatch" };
  const code = params.get("code");
  if (!code) return { ok: false, error: "missing_code" };
  return { ok: true, shop, code };
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  scope: z.string(),
  expires_in: z.number().int().positive().optional(),
  refresh_token: z.string().min(1).optional(),
  refresh_token_expires_in: z.number().int().positive().optional(),
});

export const shopifyCredentialsSchema = z.object({
  shop: z.string().refine(isShopDomain, "invalid shop domain"),
  access_token: z.string().min(1),
  scope: z.string(),
  access_token_expires_at: z.string().datetime({ offset: true }).nullable(),
  refresh_token: z.string().min(1).nullable(),
  refresh_token_expires_at: z.string().datetime({ offset: true }).nullable(),
});
export type ShopifyCredentials = z.infer<typeof shopifyCredentialsSchema>;

async function requestToken(
  shop: string,
  body: Record<string, string>,
  doFetch: typeof fetch,
  now: () => Date,
): Promise<ShopifyCredentials> {
  let response: Response;
  try {
    response = await doFetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(body).toString(),
    });
  } catch (err) {
    // The request may or may not have reached Shopify; the refresh token we hold is still safe to retry.
    throw new ShopifyApiError(
      `Shopify token request failed: ${err instanceof Error ? err.message : "network error"}`,
      "token_transport",
      true,
    );
  }
  if (response.status === 429 || response.status >= 500) {
    throw new ShopifyApiError(`Shopify token request failed (${response.status})`, `token_http_${response.status}`, true);
  }
  if (!response.ok) {
    // Shopify answers 401 invalid_request for every terminal refresh-token case (unknown, replaced,
    // expired, revoked), so the merchant has to reconnect rather than the job retrying.
    throw new ShopifyApiError(
      `Shopify rejected the token request (${response.status}); the shop must be reconnected`,
      "reauthorization_required",
      false,
    );
  }
  const token = tokenResponseSchema.parse(await response.json());
  const at = (seconds?: number) => (seconds ? new Date(now().getTime() + seconds * 1000).toISOString() : null);
  return {
    shop,
    access_token: token.access_token,
    scope: token.scope,
    access_token_expires_at: at(token.expires_in),
    refresh_token: token.refresh_token ?? null,
    refresh_token_expires_at: at(token.refresh_token_expires_in),
  };
}

export function exchangeShopifyCode(input: {
  shop: string;
  code: string;
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  now?: () => Date;
}): Promise<ShopifyCredentials> {
  return requestToken(
    input.shop,
    { client_id: input.clientId, client_secret: input.clientSecret, code: input.code, expiring: "1" },
    input.fetch ?? fetch,
    input.now ?? (() => new Date()),
  );
}

export function refreshShopifyCredentials(input: {
  credentials: ShopifyCredentials;
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  now?: () => Date;
}): Promise<ShopifyCredentials> {
  if (!input.credentials.refresh_token) throw new Error("Shopify credential has no refresh token");
  return requestToken(
    input.credentials.shop,
    {
      client_id: input.clientId,
      client_secret: input.clientSecret,
      grant_type: "refresh_token",
      refresh_token: input.credentials.refresh_token,
    },
    input.fetch ?? fetch,
    input.now ?? (() => new Date()),
  );
}
