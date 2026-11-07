import {
  AuthenticationError,
  AuthorizationError,
  requireMembership,
} from "@/lib/auth/membership";
import { parseServerEnv } from "@/lib/env";
import { verifyCallback } from "@/lib/integrations/gmail/oauth";
import {
  ErpNotConfiguredError,
  storeErpConnection,
} from "@/lib/integrations/business/live/connections";
import {
  completeZohoConnect,
  zohoAppConfig,
  zohoRedirectUri,
  ZOHO_INVENTORY_SCOPES,
} from "@/lib/integrations/business/live/zoho";

const CLEAR_COOKIE = "zoho_oauth_nonce=; Path=/api/auth/zoho; HttpOnly; Secure; SameSite=Lax; Max-Age=0";

function redirect(base: string, query: string): Response {
  const response = new Response(null, {
    status: 302,
    headers: { location: `${base}/settings/integrations?${query}` },
  });
  response.headers.append("set-cookie", CLEAR_COOKIE);
  return response;
}

export async function GET(request: Request) {
  const env = parseServerEnv(process.env);
  const base = env.APP_BASE_URL ?? "";
  const url = new URL(request.url);
  const errorRedirect = (code: string) =>
    redirect(base, `business=error&provider=zoho_inventory&code=${encodeURIComponent(code)}`);
  const nonceCookie =
    request.headers.get("cookie")?.match(/(?:^|;\s*)zoho_oauth_nonce=([^;]+)/)?.[1] ?? "";

  try {
    const membership = await requireMembership(["owner"]);
    const config = zohoAppConfig(process.env);
    if (!config || !env.CREDENTIAL_ENCRYPTION_KEY) return errorRedirect("zoho_inventory_not_configured");
    const redirectUri = zohoRedirectUri(env, request.url);
    const verified = verifyCallback({
      state: url.searchParams.get("state") ?? "",
      nonceCookie,
      sessionUserId: membership.userId,
      sessionOrgId: membership.orgId,
      sessionRole: membership.role,
      redirectUri,
      signingKey: env.CREDENTIAL_ENCRYPTION_KEY,
      now: () => new Date(),
    });
    if (!verified.ok) return errorRedirect(verified.error);
    if (url.searchParams.get("error")) return errorRedirect("consent_denied");
    const code = url.searchParams.get("code");
    if (!code) return errorRedirect("missing_code");

    const connected = await completeZohoConnect({
      code,
      accountsServer: url.searchParams.get("accounts-server"),
      redirectUri,
      config,
      fetch,
    });
    if (!connected.ok) return errorRedirect(connected.error);

    await storeErpConnection({
      orgId: verified.orgId,
      actorUserId: verified.userId,
      provider: "zoho_inventory",
      externalAccountId: connected.credentials.organization_id,
      scopes: [...ZOHO_INVENTORY_SCOPES],
      credentials: connected.credentials,
      expiresAt: null,
    });
    return redirect(base, "business=connected&provider=zoho_inventory");
  } catch (err) {
    if (err instanceof ErpNotConfiguredError) return errorRedirect("zoho_inventory_not_configured");
    if (err instanceof AuthenticationError) return errorRedirect("unauthenticated");
    if (err instanceof AuthorizationError) return errorRedirect("forbidden");
    throw err;
  }
}
