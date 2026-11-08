import {
  AuthenticationError,
  AuthorizationError,
  requireMembership,
} from "@/lib/auth/membership";
import { supabaseRpcClient } from "@/lib/db/messages";
import { createServiceClient } from "@/lib/db/service";
import { parseServerEnv } from "@/lib/env";
import { credentialKeyVersion, encryptCredential } from "@/lib/integrations/gmail/crypto";
import { safeErrorLogFields } from "@/lib/safe-error";
import { createGraphOutlookApi } from "@/lib/integrations/outlook/api";
import { outlookConfig } from "@/lib/integrations/outlook/config";
import { serializeOutlookCredential } from "@/lib/integrations/outlook/credentials";
import { createMicrosoftFetch } from "@/lib/integrations/outlook/http";
import {
  exchangeOutlookCode,
  pkceVerifier,
  verifyOutlookCallback,
} from "@/lib/integrations/outlook/oauth";
import { outlookCallbackQuerySchema } from "@/lib/integrations/outlook/schemas";

const CLEAR_COOKIE =
  "outlook_oauth_nonce=; Path=/api/auth/outlook; HttpOnly; Secure; SameSite=Lax; Max-Age=0";

function redirectTo(base: string, suffix: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location: `${base}/settings/integrations${suffix}` },
  });
}

/** Completes the consent flow and stores the mailbox as a new connection. */
export async function GET(request: Request) {
  const env = parseServerEnv(process.env);
  const base = env.APP_BASE_URL ?? "";
  const errRedirect = (code: string): Response => {
    const r = redirectTo(base, `?outlook=error&code=${encodeURIComponent(code)}`);
    r.headers.append("set-cookie", CLEAR_COOKIE);
    return r;
  };

  try {
    const membership = await requireMembership(["owner"]);
    if (env.APP_ENV === "replay") return errRedirect("outlook_unavailable_in_replay");
    const config = outlookConfig(env);
    if (!config) return errRedirect("outlook_not_configured");

    const url = new URL(request.url);
    const query = outlookCallbackQuerySchema.safeParse(
      Object.fromEntries(url.searchParams.entries()),
    );
    if (!query.success) return errRedirect("malformed");
    if (query.data.error) {
      return errRedirect(query.data.error === "access_denied" ? "access_denied" : "connection_failed");
    }
    if (!query.data.code) return errRedirect("missing_code");

    const cookieNonce =
      request.headers
        .get("cookie")
        ?.match(/(?:^|;\s*)outlook_oauth_nonce=([^;]+)/)?.[1] ?? "";
    const verified = verifyOutlookCallback({
      state: query.data.state,
      nonceCookie: cookieNonce,
      sessionUserId: membership.userId,
      sessionOrgId: membership.orgId,
      sessionRole: membership.role,
      redirectUri: config.redirectUri,
      signingKey: config.signingKey,
      now: () => new Date(),
    });
    if (!verified.ok) return errRedirect(verified.error);

    const fetchImpl = createMicrosoftFetch({ appEnv: () => env.APP_ENV });
    let tokens;
    try {
      tokens = await exchangeOutlookCode({
        config,
        code: query.data.code,
        verifier: pkceVerifier(verified.nonce, config.signingKey),
        fetchImpl,
      });
    } catch (err) {
      console.error("outlook code exchange failed", safeErrorLogFields(err));
      return errRedirect("exchange_failed");
    }

    let address: string;
    try {
      address = (
        await createGraphOutlookApi({
          fetchImpl,
          getAccessToken: async () => tokens.accessToken,
        }).getProfile()
      ).emailAddress;
    } catch (err) {
      console.error("outlook profile lookup failed", safeErrorLogFields(err));
      return errRedirect("connection_verification_failed");
    }

    const rpc = supabaseRpcClient(createServiceClient());
    await rpc.rpc("mailbox_store_connection", {
      org_id: membership.orgId,
      actor_user_id: membership.userId,
      provider: "outlook",
      external_account_id: address,
      scopes: tokens.scopes,
      capabilities: { mail_read: true, mail_send: true },
      encrypted_b64: encryptCredential(
        serializeOutlookCredential({ provider: "outlook", refreshToken: tokens.refreshToken }),
        config.signingKey,
      ),
      key_version: credentialKeyVersion(config.signingKey),
      expires_at: null,
    });

    const r = redirectTo(base, "?outlook=connected");
    r.headers.append("set-cookie", CLEAR_COOKIE);
    return r;
  } catch (err) {
    if (err instanceof AuthenticationError || err instanceof AuthorizationError) {
      return errRedirect("unauthorized");
    }
    throw err;
  }
}
