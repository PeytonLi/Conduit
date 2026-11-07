import {
  AuthenticationError,
  AuthorizationError,
  requireMembership,
} from "@/lib/auth/membership";
import { parseServerEnv } from "@/lib/env";
import { ErpNotConfiguredError, storeErpConnection } from "@/lib/integrations/business/live/connections";
import {
  SHOPIFY_STATE_COOKIE,
  exchangeShopifyCode,
  verifyShopifyCallback,
} from "@/lib/integrations/business/live/shopify/oauth";

const clearCookie = `${SHOPIFY_STATE_COOKIE}=; Path=/api/auth/shopify; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

function redirectTo(base: string, query: string): Response {
  const response = new Response(null, {
    status: 302,
    headers: { location: `${base}/settings/integrations?${query}` },
  });
  response.headers.append("set-cookie", clearCookie);
  return response;
}

export async function GET(request: Request) {
  const env = parseServerEnv(process.env);
  const base = env.APP_BASE_URL ?? "";
  const errRedirect = (code: string) => redirectTo(base, `business=error&provider=shopify&code=${encodeURIComponent(code)}`);
  const url = new URL(request.url);
  const nonceCookie =
    request.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${SHOPIFY_STATE_COOKIE}=([^;]+)`))?.[1] ?? "";

  try {
    const membership = await requireMembership(["owner"]);
    if (!env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET || !env.CREDENTIAL_ENCRYPTION_KEY) {
      return errRedirect("shopify_not_configured");
    }
    const verified = verifyShopifyCallback({
      params: url.searchParams,
      nonceCookie,
      sessionOrgId: membership.orgId,
      sessionUserId: membership.userId,
      clientSecret: env.SHOPIFY_CLIENT_SECRET,
      signingKey: env.CREDENTIAL_ENCRYPTION_KEY,
      now: () => new Date(),
    });
    if (!verified.ok) return errRedirect(`shopify_${verified.error}`);

    let credentials;
    try {
      credentials = await exchangeShopifyCode({
        shop: verified.shop,
        code: verified.code,
        clientId: env.SHOPIFY_CLIENT_ID,
        clientSecret: env.SHOPIFY_CLIENT_SECRET,
      });
    } catch {
      return errRedirect("shopify_exchange_failed");
    }

    try {
      await storeErpConnection({
        orgId: membership.orgId,
        actorUserId: membership.userId,
        provider: "shopify",
        externalAccountId: verified.shop,
        scopes: credentials.scope.split(",").map((s) => s.trim()).filter(Boolean),
        credentials,
        expiresAt: credentials.refresh_token_expires_at ?? credentials.access_token_expires_at,
      });
    } catch (err) {
      if (err instanceof ErpNotConfiguredError) return errRedirect("shopify_not_configured");
      throw err;
    }
    return redirectTo(base, "business=connected&provider=shopify");
  } catch (err) {
    if (err instanceof AuthenticationError || err instanceof AuthorizationError) {
      return errRedirect("unauthorized");
    }
    throw err;
  }
}
