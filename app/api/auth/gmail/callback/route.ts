import { google } from "googleapis";
import {
  AuthenticationError,
  AuthorizationError,
  requireMembership,
} from "@/lib/auth/membership";
import { createServiceClient } from "@/lib/db/service";
import { supabaseRpcClient } from "@/lib/db/messages";
import { parseServerEnv } from "@/lib/env";
import { createComposioClient } from "@/lib/integrations/gmail/composio-client";
import { encryptCredential } from "@/lib/integrations/gmail/crypto";
import { credentialKeyVersion } from "@/lib/integrations/gmail/crypto";
import { serializeGmailCredential } from "@/lib/integrations/gmail/credentials";
import { verifyCallback, exchangeCode } from "@/lib/integrations/gmail/oauth";

function redirectTo(base: string, suffix: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location: `${base}/settings/integrations${suffix}` },
  });
}

export async function GET(request: Request) {
  const env = parseServerEnv(process.env);
  const base = env.APP_BASE_URL ?? "";
  const clearCookie =
    "gmail_oauth_nonce=; Path=/api/auth/gmail; HttpOnly; Secure; SameSite=Lax; Max-Age=0";

  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const callbackStatus = url.searchParams.get("status");
  const connectedAccountId = url.searchParams.get("connected_account_id") ?? "";
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
    if (!env.CREDENTIAL_ENCRYPTION_KEY) {
      return errRedirect("gmail_not_configured");
    }
    const redirectUri =
      env.GMAIL_PROVIDER === "composio"
        ? new URL(
            "/api/auth/gmail/callback",
            env.APP_BASE_URL ? new URL(env.APP_BASE_URL).origin : url.origin,
          ).toString()
        : env.GOOGLE_REDIRECT_URI;
    if (!redirectUri) return errRedirect("gmail_not_configured");
    const verified = verifyCallback({
      state,
      nonceCookie: cookieNonce,
      sessionUserId: membership.userId,
      sessionOrgId: membership.orgId,
      sessionRole: membership.role,
      redirectUri,
      signingKey: env.CREDENTIAL_ENCRYPTION_KEY,
      now: () => new Date(),
    });
    if (!verified.ok) return errRedirect(verified.error);

    if (env.GMAIL_PROVIDER === "composio") {
      if (!env.COMPOSIO_API_KEY || !env.COMPOSIO_GMAIL_AUTH_CONFIG_ID) {
        return errRedirect("gmail_not_configured");
      }
      if (callbackStatus !== "success" || !connectedAccountId) {
        return errRedirect("connection_failed");
      }
      let account;
      try {
        const accounts = await createComposioClient(env.COMPOSIO_API_KEY).connectedAccounts.list({
          userIds: [membership.orgId],
          toolkitSlugs: ["gmail"],
          limit: 100,
        });
        account = accounts.items.find(
          (item) =>
            item.id === connectedAccountId &&
            item.toolkit.slug === "gmail" &&
            item.status === "ACTIVE" &&
            item.authConfig.id === env.COMPOSIO_GMAIL_AUTH_CONFIG_ID,
        );
      } catch {
        return errRedirect("connection_verification_failed");
      }
      if (!account) return errRedirect("connection_verification_failed");

      const encrypted = encryptCredential(
        serializeGmailCredential({
          provider: "composio",
          connectedAccountId,
        }),
        env.CREDENTIAL_ENCRYPTION_KEY,
      );
      const rpc = supabaseRpcClient(createServiceClient());
      const externalAccountId =
        [
          account.data?.email,
          account.data?.email_address,
          account.data?.emailAddress,
        ].find((value): value is string => typeof value === "string" && value.length > 0) ??
        connectedAccountId;
      await rpc.rpc("gmail_store_connection", {
        org_id: membership.orgId,
        actor_user_id: membership.userId,
        external_account_id: externalAccountId,
        scopes: ["gmail.readonly", "gmail.send"],
        encrypted_b64: encrypted,
        key_version: credentialKeyVersion(env.CREDENTIAL_ENCRYPTION_KEY),
        expires_at: null,
      });
      const r = redirectTo(base, "?gmail=connected");
      r.headers.append("set-cookie", clearCookie);
      return r;
    }

    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REDIRECT_URI) {
      return errRedirect("gmail_not_configured");
    }
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
      serializeGmailCredential({
        provider: "google",
        refreshToken: exchanged.refreshToken,
      }),
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
