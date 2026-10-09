import { randomUUID } from "node:crypto";
import { google } from "googleapis";
import { ok, fail } from "@/lib/api/http";
import {
  AuthenticationError,
  AuthorizationError,
  requireMembership,
} from "@/lib/auth/membership";
import { parseServerEnv } from "@/lib/env";
import { buildAuthorizationUrl } from "@/lib/integrations/gmail/oauth";

export async function POST() {
  try {
    const membership = await requireMembership(["owner"]);
    const env = parseServerEnv(process.env);
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
    const nonce = randomUUID();
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
