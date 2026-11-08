import { randomUUID } from "node:crypto";
import { ok, fail } from "@/lib/api/http";
import {
  AuthenticationError,
  AuthorizationError,
  requireMembership,
} from "@/lib/auth/membership";
import { parseServerEnv } from "@/lib/env";
import { outlookConfig } from "@/lib/integrations/outlook/config";
import { buildOutlookAuthorizationUrl, createOutlookState } from "@/lib/integrations/outlook/oauth";

/** Starts the Microsoft consent flow for an owner adding an Outlook mailbox. */
export async function POST() {
  try {
    const membership = await requireMembership(["owner"]);
    const env = parseServerEnv(process.env);
    if (env.APP_ENV === "replay") {
      return fail(
        "outlook_unavailable_in_replay",
        "Outlook is not contacted in replay mode",
        409,
        false,
      );
    }
    const config = outlookConfig(env);
    if (!config) {
      return fail(
        "outlook_not_configured",
        "Outlook integration is not configured",
        503,
        false,
      );
    }
    const nonce = randomUUID();
    const state = createOutlookState({
      orgId: membership.orgId,
      userId: membership.userId,
      nonce,
      redirectUri: config.redirectUri,
      signingKey: config.signingKey,
      now: () => new Date(),
    });
    const response = ok({
      authorization_url: buildOutlookAuthorizationUrl({ config, state, nonce }),
    });
    response.headers.append(
      "set-cookie",
      `outlook_oauth_nonce=${nonce}; Path=/api/auth/outlook; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
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
