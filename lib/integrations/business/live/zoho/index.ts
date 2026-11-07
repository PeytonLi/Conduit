import { ErpNotConfiguredError } from "../errors";
import type { ErpProviderDefinition } from "../types";
import { createZohoInventoryClient } from "./client";
import { ZohoAuthError } from "./errors";
import { zohoAppConfig } from "./oauth";
import { zohoCredentialsSchema } from "./schemas";

export { createZohoInventoryClient, DEFAULT_ZOHO_LIMITS, zohoFollowUpReference } from "./client";
export { zohoAccountsServer, zohoInventoryBaseUrl } from "./domains";
export * from "./errors";
export {
  buildZohoAuthorizationUrl,
  completeZohoConnect,
  zohoAppConfig,
  zohoRedirectUri,
  ZOHO_CALLBACK_PATH,
  ZOHO_INVENTORY_SCOPES,
} from "./oauth";
export { zohoCredentialsSchema, type ZohoCredentials } from "./schemas";

export const zohoInventoryProvider: ErpProviderDefinition = {
  provider: "zoho_inventory",
  label: "Zoho Inventory",
  createClient(credentials, deps = {}) {
    const config = zohoAppConfig(process.env);
    if (!config) throw new ErpNotConfiguredError("ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET are not set");
    const parsed = zohoCredentialsSchema.safeParse(credentials);
    if (!parsed.success) throw new ZohoAuthError("Stored Zoho Inventory credential is invalid; reconnect Zoho");
    return createZohoInventoryClient({
      credentials: parsed.data,
      ...config,
      fetch: deps.fetch ?? fetch,
      now: deps.now ?? (() => new Date()),
    });
  },
};
