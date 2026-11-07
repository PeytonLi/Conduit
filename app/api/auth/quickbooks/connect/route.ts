import { randomUUID } from "node:crypto";
import { ok, fail } from "@/lib/api/http";
import { AuthenticationError, AuthorizationError, requireMembership } from "@/lib/auth/membership";
import { readQboConfig } from "@/lib/integrations/business/live/quickbooks/config";
import { buildQboAuthorizationUrl } from "@/lib/integrations/business/live/quickbooks/oauth";
import { createGmailState } from "@/lib/integrations/gmail/oauth";

const QBO_NONCE_COOKIE = "quickbooks_oauth_nonce";

async function start(request: Request): Promise<{ url: string; nonce: string } | Response> {
  try {
    const membership = await requireMembership(["owner"]);
    const result = readQboConfig(process.env, new URL(request.url).origin);
    if (!result.configured) {
      return fail("quickbooks_not_configured", "QuickBooks integration is not configured", 503, false);
    }
    const { config } = result;
    const nonce = randomUUID();
    const state = createGmailState({
      orgId: membership.orgId,
      userId: membership.userId,
      nonce,
      redirectUri: config.redirectUri,
      signingKey: config.encryptionKey,
      now: () => new Date(),
    });
    return { url: buildQboAuthorizationUrl({ clientId: config.clientId, redirectUri: config.redirectUri, state }), nonce };
  } catch (err) {
    if (err instanceof AuthenticationError) return fail("unauthenticated", err.message, 401, false);
    if (err instanceof AuthorizationError) return fail("forbidden", err.message, 403, false);
    throw err;
  }
}

const nonceCookie = (nonce: string) =>
  `${QBO_NONCE_COOKIE}=${nonce}; Path=/api/auth/quickbooks; HttpOnly; Secure; SameSite=Lax; Max-Age=600`;

export async function POST(request: Request) {
  const started = await start(request);
  if (started instanceof Response) return started;
  const response = ok({ authorization_url: started.url });
  response.headers.append("set-cookie", nonceCookie(started.nonce));
  return response;
}
