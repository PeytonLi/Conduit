import { serverEnvSchema } from "@/lib/env";
import type { ErpProviderDefinition } from "../types";
import { createShopifyErpClient } from "./client";
import { ShopifyApiError, createShopifyGraphql, type ShopifyGraphql } from "./graphql";
import { refreshShopifyCredentials, shopifyCredentialsSchema, type ShopifyCredentials } from "./oauth";
const REFRESH_MARGIN_MS = 60_000;

export interface RefreshingGraphqlInput {
  credentials: ShopifyCredentials;
  fetch?: typeof fetch;
  now?: () => Date;
  saveCredentials?: (credentials: unknown, expiresAt: string | null) => Promise<void>;
  /** Defaults to SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET. */
  clientId?: string;
  clientSecret?: string;
}

/**
 * Admin GraphQL caller for an expiring offline token. It refreshes shortly before expiry (and once more
 * after a 401), one refresh at a time, and hands every rotated pair to `saveCredentials`.
 *
 * Shopify keeps accepting the refresh token that was presented until the replacement is used, so if saving
 * the rotated pair fails the new access token still serves this process, but the next refresh presents the
 * last refresh token that was actually stored. Advancing in memory only would retire the stored one and
 * strand the shop. A terminal refresh failure (401) is a `reauthorization_required` ShopifyApiError.
 */
export function createRefreshingShopifyGraphql(input: RefreshingGraphqlInput): ShopifyGraphql {
  const now = input.now ?? (() => new Date());
  let credentials = input.credentials;
  /** The credential whose refresh_token is the newest one known to be stored. */
  let stored = input.credentials;
  let client = createShopifyGraphql({ shop: credentials.shop, accessToken: credentials.access_token, fetch: input.fetch });
  let refreshing: Promise<void> | null = null;

  function appCredentials() {
    if (input.clientId && input.clientSecret) return { clientId: input.clientId, clientSecret: input.clientSecret };
    const env = serverEnvSchema.pick({ SHOPIFY_CLIENT_ID: true, SHOPIFY_CLIENT_SECRET: true }).parse(process.env);
    if (!env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) return null;
    return { clientId: env.SHOPIFY_CLIENT_ID, clientSecret: env.SHOPIFY_CLIENT_SECRET };
  }

  const canRefresh = () => stored.refresh_token !== null && appCredentials() !== null;

  const expired = () =>
    credentials.access_token_expires_at !== null &&
    Date.parse(credentials.access_token_expires_at) - REFRESH_MARGIN_MS <= now().getTime();

  async function refresh() {
    const app = appCredentials();
    if (!stored.refresh_token || !app) {
      throw new ShopifyApiError(
        "The Shopify access token expired and cannot be refreshed (no refresh token or app credentials)",
        "reauthorization_required",
        false,
      );
    }
    const next = await refreshShopifyCredentials({
      credentials: stored,
      clientId: app.clientId,
      clientSecret: app.clientSecret,
      fetch: input.fetch,
      now,
    });
    credentials = next;
    client = createShopifyGraphql({ shop: next.shop, accessToken: next.access_token, fetch: input.fetch });
    if (!input.saveCredentials) {
      stored = next;
      return;
    }
    try {
      await input.saveCredentials(next, next.refresh_token_expires_at ?? next.access_token_expires_at);
      stored = next;
    } catch {
      // Keep `stored` on the previous refresh token: Shopify still honors it, and a retry returns the same pair.
    }
  }

  const refreshOnce = async () => {
    refreshing ??= refresh().finally(() => {
      refreshing = null;
    });
    await refreshing;
  };

  return async (operationName, query, variables, schema) => {
    if (refreshing || expired()) await refreshOnce();
    const used = credentials.access_token;
    try {
      return await client(operationName, query, variables, schema);
    } catch (err) {
      if (!(err instanceof ShopifyApiError) || err.code !== "unauthorized" || !canRefresh()) throw err;
      if (credentials.access_token === used) await refreshOnce();
      if (credentials.access_token === used) throw err;
      return client(operationName, query, variables, schema);
    }
  };
}

export const shopifyProvider: ErpProviderDefinition = {
  provider: "shopify",
  label: "Shopify",
  createClient(credentials, deps = {}) {
    const parsed = shopifyCredentialsSchema.parse(credentials);
    const now = deps.now ?? (() => new Date());
    const graphql = createRefreshingShopifyGraphql({
      credentials: parsed,
      fetch: deps.fetch,
      now,
      saveCredentials: deps.saveCredentials,
    });
    return createShopifyErpClient({ graphql, now });
  },
};

export { SHOPIFY_SCOPES } from "./oauth";
