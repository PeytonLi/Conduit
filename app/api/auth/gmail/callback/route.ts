import { google } from "googleapis";
import {
  AuthenticationError,
  AuthorizationError,
  requireMembership,
} from "@/lib/auth/membership";
import { createServiceClient } from "@/lib/db/service";
import { supabaseRpcClient } from "@/lib/db/messages";
import { parseServerEnv } from "@/lib/env";
import { encryptCredential } from "@/lib/integrations/gmail/crypto";
import { credentialKeyVersion } from "@/lib/integrations/gmail/crypto";
import { verifyCallback, exchangeCode } from "@/lib/integrations/gmail/oauth";

function redirectTo(base: string, suffix: string): Response {
  return Response.redirect(`${base}/settings/integrations${suffix}`, 302);
}

export async function GET(request: Request) {
  const env = parseServerEnv(process.env);
  const base = env.APP_BASE_URL ?? "";
  const clearCookie =
    "gmail_oauth_nonce=; Path=/api/auth/gmail; HttpOnly; Secure; SameSite=Lax; Max-Age=0";

  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const cookieNonce =
    request.headers
      .get("cookie")
      ?.match(/(?:^|;\s*)gmail_oauth_nonce=([^;]+)/)?.[1] ?? "";

  const errRedirect = (code2: string): Response => {
    const r = redirectTo(base, `?gmail=error&code=${encodeURIComponent(code2)}`);
    r.headers.append("set-cookie", clearCookie);
    return r;
  };

  try {
    const membership = await requireMembership(["owner"]);
    if (!env.CREDENTIAL_ENCRYPTION_KEY || !env.GOOGLE_REDIRECT_URI) {
      return errRedirect("gmail_not_configured");
    }
    const verified = verifyCallback({
      state,
      nonceCookie: cookieNonce,
      sessionUserId: membership.userId,
      sessionOrgId: membership.orgId,
      sessionRole: membership.role,
      redirectUri: env.GOOGLE_REDIRECT_URI,
      signingKey: env.CREDENTIAL_ENCRYPTION_KEY,
      now: () => new Date(),
    });
    if (!verified.ok) return errRedirect(verified.error);
    if (!code) return errRedirect("missing_code");

    const oauth2 = new google.auth.OAuth2(
      env.GOOGLE_CLIENT_ID,
      env.GOOGLE_CLIENT_SECRET,
      env.GOOGLE_REDIRECT_URI,
    );
    let exchanged;
    try {
      exchanged = await exchangeCode(oauth2, code);
    } catch {
      return errRedirect("exchange_failed");
    }

    const encrypted = encryptCredential(
      exchanged.refreshToken,
      env.CREDENTIAL_ENCRYPTION_KEY,
    );
    const rpc = supabaseRpcClient(createServiceClient());
    await rpc.rpc("gmail_store_connection", {
      org_id: membership.orgId,
      actor_user_id: membership.userId,
      external_account_id: exchanged.emailAddress,
      scopes: exchanged.scopes,
      encrypted_b64: encrypted,
      key_version: credentialKeyVersion(env.CREDENTIAL_ENCRYPTION_KEY),
      expires_at: exchanged.expiresAt,
    });

    const r = redirectTo(base, "?gmail=connected");
    r.headers.append("set-cookie", clearCookie);
    return r;
  } catch (err) {
    if (err instanceof AuthenticationError || err instanceof AuthorizationError) {
      return errRedirect("unauthorized");
    }
    throw err;
  }
}
