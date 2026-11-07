import { serverEnvSchema } from "@/lib/env";
import type { ErpProviderDefinition } from "../types";
import { createShopifyErpClient } from "./client";
import { createShopifyGraphql, type ShopifyGraphql } from "./graphql";
import { refreshShopifyCredentials, shopifyCredentialsSchema, type ShopifyCredentials } from "./oauth";

const REFRESH_MARGIN_MS = 60_000;

type SaveCredentials = (credentials: unknown, expiresAt: string | null) => Promise<void>;

/**
 * Refreshes an expiring offline token and persists the rotated pair. If saving fails, the new token is
 * still used in memory; Shopify keeps accepting the stored refresh token for 30 days after its first use.
 */
function refreshingGraphql(
  initial: ShopifyCredentials,
  fetchImpl: typeof fetch | undefined,
  now: () => Date,
  saveCredentials: SaveCredentials | undefined,
): ShopifyGraphql {
  let credentials = initial;
  let client = createShopifyGraphql({ shop: credentials.shop, accessToken: credentials.access_token, fetch: fetchImpl });
  let refreshing: Promise<void> | null = null;

  const expired = () =>
    credentials.access_token_expires_at !== null &&
    Date.parse(credentials.access_token_expires_at) - REFRESH_MARGIN_MS <= now().getTime();

  async function refresh() {
    const env = serverEnvSchema.pick({ SHOPIFY_CLIENT_ID: true, SHOPIFY_CLIENT_SECRET: true }).parse(process.env);
    if (!env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET || !credentials.refresh_token) return;
    credentials = await refreshShopifyCredentials({
      credentials,
      clientId: env.SHOPIFY_CLIENT_ID,
      clientSecret: env.SHOPIFY_CLIENT_SECRET,
      fetch: fetchImpl,
      now,
    });
    client = createShopifyGraphql({ shop: credentials.shop, accessToken: credentials.access_token, fetch: fetchImpl });
    await saveCredentials?.(credentials, credentials.refresh_token_expires_at ?? credentials.access_token_expires_at).catch(() => undefined);
  }

  return async (operationName, query, variables, schema) => {
    if (expired()) {
      refreshing ??= refresh().finally(() => {
        refreshing = null;
      });
      await refreshing;
    }
    return client(operationName, query, variables, schema);
  };
}

export const shopifyProvider: ErpProviderDefinition = {
  provider: "shopify",
  label: "Shopify",
  createClient(credentials, deps = {}) {
    const parsed = shopifyCredentialsSchema.parse(credentials);
    const now = deps.now ?? (() => new Date());
    return createShopifyErpClient({ graphql: refreshingGraphql(parsed, deps.fetch, now, deps.saveCredentials), now });
  },
};

export { SHOPIFY_SCOPES } from "./oauth";
