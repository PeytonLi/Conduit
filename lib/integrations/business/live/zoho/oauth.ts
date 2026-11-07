import { z } from "zod";
import { DEFAULT_ZOHO_ACCOUNTS_SERVER, zohoAccountsServer, zohoInventoryBaseUrl } from "./domains";
import { zohoOrganizationsResponseSchema, zohoTokenResponseSchema, type ZohoCredentials } from "./schemas";

/** Read everything the snapshot needs; write only what the delivery split touches. */
export const ZOHO_INVENTORY_SCOPES = [
  "ZohoInventory.purchaseorders.READ",
  "ZohoInventory.purchaseorders.CREATE",
  "ZohoInventory.purchaseorders.UPDATE",
  "ZohoInventory.purchasereceives.READ",
  "ZohoInventory.items.READ",
  "ZohoInventory.salesorders.READ",
  "ZohoInventory.settings.READ",
] as const;

export const ZOHO_CALLBACK_PATH = "/api/auth/zoho/callback";

export interface ZohoAppConfig {
  clientId: string;
  clientSecret: string;
}

const appConfigSchema = z.object({
  ZOHO_CLIENT_ID: z.string().trim().min(1),
  ZOHO_CLIENT_SECRET: z.string().trim().min(1),
});

export function zohoAppConfig(env: Record<string, string | undefined>): ZohoAppConfig | null {
  const parsed = appConfigSchema.safeParse(env);
  return parsed.success
    ? { clientId: parsed.data.ZOHO_CLIENT_ID, clientSecret: parsed.data.ZOHO_CLIENT_SECRET }
    : null;
}

export function zohoRedirectUri(
  env: { ZOHO_REDIRECT_URI?: string; APP_BASE_URL?: string },
  requestUrl: string,
): string {
  if (env.ZOHO_REDIRECT_URI) return env.ZOHO_REDIRECT_URI;
  const origin = env.APP_BASE_URL ? new URL(env.APP_BASE_URL).origin : new URL(requestUrl).origin;
  return new URL(ZOHO_CALLBACK_PATH, origin).toString();
}

/** Users on other data centers are redirected by accounts.zoho.com and come back with `accounts-server`. */
export function buildZohoAuthorizationUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL("/oauth/v2/auth", DEFAULT_ZOHO_ACCOUNTS_SERVER);
  url.searchParams.set("scope", ZOHO_INVENTORY_SCOPES.join(","));
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", input.state);
  return url.toString();
}

export type ZohoConnectError =
  | "unknown_data_center"
  | "exchange_failed"
  | "no_refresh_token"
  | "organization_lookup_failed"
  | "no_organization";

export async function completeZohoConnect(input: {
  code: string;
  accountsServer: string | null;
  redirectUri: string;
  config: ZohoAppConfig;
  fetch: typeof fetch;
}): Promise<
  | { ok: true; credentials: ZohoCredentials; organizationName: string }
  | { ok: false; error: ZohoConnectError }
> {
  const accountsServer = zohoAccountsServer(input.accountsServer ?? DEFAULT_ZOHO_ACCOUNTS_SERVER);
  if (!accountsServer) return { ok: false, error: "unknown_data_center" };

  let token: z.infer<typeof zohoTokenResponseSchema>;
  try {
    const response = await input.fetch(`${accountsServer}/oauth/v2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: input.code,
        client_id: input.config.clientId,
        client_secret: input.config.clientSecret,
        redirect_uri: input.redirectUri,
      }),
    });
    const parsed = zohoTokenResponseSchema.safeParse(await response.json());
    if (!response.ok || !parsed.success) return { ok: false, error: "exchange_failed" };
    token = parsed.data;
  } catch {
    return { ok: false, error: "exchange_failed" };
  }
  if ("error" in token) return { ok: false, error: "exchange_failed" };
  if (!token.refresh_token) return { ok: false, error: "no_refresh_token" };
  const apiDomain = token.api_domain ?? "https://www.zohoapis.com";
  const baseUrl = zohoInventoryBaseUrl(apiDomain);
  if (!baseUrl) return { ok: false, error: "unknown_data_center" };

  let organizations: z.infer<typeof zohoOrganizationsResponseSchema>["organizations"];
  try {
    const response = await input.fetch(`${baseUrl}/organizations`, {
      headers: { authorization: `Zoho-oauthtoken ${token.access_token}`, accept: "application/json" },
    });
    const parsed = zohoOrganizationsResponseSchema.safeParse(await response.json());
    if (!response.ok || !parsed.success) return { ok: false, error: "organization_lookup_failed" };
    organizations = parsed.data.organizations;
  } catch {
    return { ok: false, error: "organization_lookup_failed" };
  }
  const organization = organizations.length === 1
    ? organizations[0]
    : organizations.find((candidate) => candidate.is_default_org);
  if (!organization) return { ok: false, error: "no_organization" };

  return {
    ok: true,
    organizationName: organization.name,
    credentials: {
      refresh_token: token.refresh_token,
      api_domain: apiDomain,
      accounts_server: accountsServer,
      organization_id: organization.organization_id,
    },
  };
}
