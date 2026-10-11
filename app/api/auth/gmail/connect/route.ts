import { randomUUID } from "node:crypto";
import { google } from "googleapis";
import { ok, fail } from "@/lib/api/http";
import {
  AuthenticationError,
  AuthorizationError,
  requireMembership,
} from "@/lib/auth/membership";
import { parseServerEnv } from "@/lib/env";
import { createComposioClient } from "@/lib/integrations/gmail/composio-client";
import { buildAuthorizationUrl, createGmailState } from "@/lib/integrations/gmail/oauth";

export async function POST(request: Request) {
  try {
    const membership = await requireMembership(["owner"]);
    const env = parseServerEnv(process.env);
    const nonce = randomUUID();
    if (env.GMAIL_PROVIDER === "composio") {
      if (
        !env.COMPOSIO_API_KEY ||
        !env.COMPOSIO_GMAIL_AUTH_CONFIG_ID ||
        !env.CREDENTIAL_ENCRYPTION_KEY
      ) {
        return fail(
          "gmail_not_configured",
          "Gmail integration is not configured",
          503,
          false,
        );
      }
      const origin = env.APP_BASE_URL
        ? new URL(env.APP_BASE_URL).origin
        : new URL(request.url).origin;
      const callback = new URL("/api/auth/gmail/callback", origin);
      const redirectUri = callback.toString();
      const state = createGmailState({
        orgId: membership.orgId,
        userId: membership.userId,
        nonce,
        redirectUri,
        signingKey: env.CREDENTIAL_ENCRYPTION_KEY,
        now: () => new Date(),
      });
      callback.searchParams.set("state", state);
      const link = await createComposioClient(env.COMPOSIO_API_KEY).connectedAccounts.link(
        membership.orgId,
        env.COMPOSIO_GMAIL_AUTH_CONFIG_ID,
        { callbackUrl: callback.toString() },
      );
      const response = ok({ authorization_url: link.redirectUrl });
      response.headers.append(
        "set-cookie",
        `gmail_oauth_nonce=${nonce}; Path=/api/auth/gmail; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
      );
      return response;
    }
    if (
      !env.GOOGLE_CLIENT_ID ||
      !env.GOOGLE_CLIENT_SECRET ||
      !env.GOOGLE_REDIRECT_URI ||
      !env.CREDENTIAL_ENCRYPTION_KEY
    ) {
      return fail(
        "gmail_not_configured",
        "Gmail integration is not configured",
        503,
        false,
      );
    }
    const oauth2 = new google.auth.OAuth2(
      env.GOOGLE_CLIENT_ID,
      env.GOOGLE_CLIENT_SECRET,
      env.GOOGLE_REDIRECT_URI,
    );
    const url = buildAuthorizationUrl({
      oauth2,
      orgId: membership.orgId,
      userId: membership.userId,
      nonce,
      redirectUri: env.GOOGLE_REDIRECT_URI,
      signingKey: env.CREDENTIAL_ENCRYPTION_KEY,
      now: () => new Date(),
    });
    const response = ok({ authorization_url: url });
    response.headers.append(
      "set-cookie",
      `gmail_oauth_nonce=${nonce}; Path=/api/auth/gmail; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    );
    return response;
  } catch (err) {
    if (err instanceof AuthenticationError) {
      return fail("unauthenticated", err.message, 401, false);
    }
    if (err instanceof AuthorizationError) {
      return fail("forbidden", err.message, 403, false);
    }
    throw err;
  }
}
