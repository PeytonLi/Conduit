import { serverEnvSchema } from "@/lib/env";
import type { ErpProviderDefinition } from "../types";
import { createShopifyErpClient } from "./client";
import { createShopifyGraphql, type ShopifyGraphql } from "./graphql";
import { refreshShopifyCredentials, shopifyCredentialsSchema, type ShopifyCredentials } from "./oauth";

const REFRESH_MARGIN_MS = 60_000;

/**
 * Refreshes an expiring offline token in memory. The rotated refresh token is not persisted, so
 * Shopify keeps accepting the stored one for 30 days after its first refresh; reconnect after that.
 */
function refreshingGraphql(initial: ShopifyCredentials, fetchImpl: typeof fetch | undefined, now: () => Date): ShopifyGraphql {
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
    return createShopifyErpClient({ graphql: refreshingGraphql(parsed, deps.fetch, now), now });
  },
};

export { SHOPIFY_SCOPES } from "./oauth";
