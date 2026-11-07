import { randomUUID } from "node:crypto";
import { fail, ok } from "@/lib/api/http";
import {
  AuthenticationError,
  AuthorizationError,
  requireMembership,
} from "@/lib/auth/membership";
import { parseServerEnv } from "@/lib/env";
import { createGmailState } from "@/lib/integrations/gmail/oauth";
import {
  buildZohoAuthorizationUrl,
  zohoAppConfig,
  zohoRedirectUri,
} from "@/lib/integrations/business/live/zoho";

const NONCE_COOKIE = "zoho_oauth_nonce";

async function start(request: Request): Promise<
  | { ok: true; url: string; cookie: string }
  | { ok: false; response: Response }
> {
  try {
    const membership = await requireMembership(["owner"]);
    const env = parseServerEnv(process.env);
    const config = zohoAppConfig(process.env);
    if (!config || !env.CREDENTIAL_ENCRYPTION_KEY) {
      return {
        ok: false,
        response: fail("zoho_inventory_not_configured", "Zoho Inventory is not configured", 503, false),
      };
    }
    const nonce = randomUUID();
    const redirectUri = zohoRedirectUri(env, request.url);
    const state = createGmailState({
      orgId: membership.orgId,
      userId: membership.userId,
      nonce,
      redirectUri,
      signingKey: env.CREDENTIAL_ENCRYPTION_KEY,
      now: () => new Date(),
    });
    return {
      ok: true,
      url: buildZohoAuthorizationUrl({ clientId: config.clientId, redirectUri, state }),
      cookie: `${NONCE_COOKIE}=${nonce}; Path=/api/auth/zoho; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    };
  } catch (err) {
    if (err instanceof AuthenticationError) {
      return { ok: false, response: fail("unauthenticated", err.message, 401, false) };
    }
    if (err instanceof AuthorizationError) {
      return { ok: false, response: fail("forbidden", err.message, 403, false) };
    }
    throw err;
  }
}

export async function POST(request: Request) {
  const started = await start(request);
  if (!started.ok) return started.response;
  const response = ok({ authorization_url: started.url });
  response.headers.append("set-cookie", started.cookie);
  return response;
}
