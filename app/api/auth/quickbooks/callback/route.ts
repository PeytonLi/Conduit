import { AuthenticationError, AuthorizationError, requireMembership } from "@/lib/auth/membership";
import { ErpNotConfiguredError, storeErpConnection } from "@/lib/integrations/business/live/connections";
import { QBO_SCOPE, readQboConfig } from "@/lib/integrations/business/live/quickbooks/config";
import { credentialsFromTokens, exchangeQboCode } from "@/lib/integrations/business/live/quickbooks/oauth";
import { verifyCallback } from "@/lib/integrations/gmail/oauth";

const CLEAR_COOKIE = "quickbooks_oauth_nonce=; Path=/api/auth/quickbooks; HttpOnly; Secure; SameSite=Lax; Max-Age=0";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const base = process.env.APP_BASE_URL ? new URL(process.env.APP_BASE_URL).origin : "";
  const redirect = (suffix: string): Response =>
    new Response(null, {
      status: 302,
      headers: { location: `${base}/settings/integrations${suffix}`, "set-cookie": CLEAR_COOKIE },
    });
  const fail = (code: string) => redirect(`?business=error&provider=quickbooks&code=${encodeURIComponent(code)}`);

  try {
    const membership = await requireMembership(["owner"]);
    const result = readQboConfig(process.env, url.origin);
    if (!result.configured) return fail("quickbooks_not_configured");
    const { config } = result;
    const nonceCookie = request.headers.get("cookie")?.match(/(?:^|;\s*)quickbooks_oauth_nonce=([^;]+)/)?.[1] ?? "";
    const verified = verifyCallback({
      state: url.searchParams.get("state") ?? "",
      nonceCookie,
      sessionUserId: membership.userId,
      sessionOrgId: membership.orgId,
      sessionRole: membership.role,
      redirectUri: config.redirectUri,
      signingKey: config.encryptionKey,
      now: () => new Date(),
    });
    if (!verified.ok) return fail(verified.error);
    if (url.searchParams.get("error")) return fail("consent_denied");
    const code = url.searchParams.get("code") ?? "";
    const realmId = url.searchParams.get("realmId") ?? "";
    if (!code) return fail("missing_code");
    if (!/^\d+$/.test(realmId)) return fail("missing_realm");

    let tokens;
    try {
      tokens = await exchangeQboCode({ code, redirectUri: config.redirectUri, clientId: config.clientId, clientSecret: config.clientSecret });
    } catch {
      return fail("exchange_failed");
    }
    const credentials = credentialsFromTokens(tokens, { realm_id: realmId, environment: config.environment }, new Date());
    try {
      await storeErpConnection({
        orgId: membership.orgId,
        actorUserId: membership.userId,
        provider: "quickbooks",
        externalAccountId: realmId,
        scopes: [QBO_SCOPE],
        credentials,
        expiresAt: credentials.refresh_token_expires_at,
      });
    } catch (err) {
      if (err instanceof ErpNotConfiguredError) return fail("quickbooks_not_configured");
      throw err;
    }
    return redirect("?business=connected&provider=quickbooks");
  } catch (err) {
    if (err instanceof AuthenticationError || err instanceof AuthorizationError) return fail("unauthorized");
    throw err;
  }
}
