import { z } from "zod";
import { fail, ok, parseBody } from "@/lib/api/http";
import {
  AuthenticationError,
  AuthorizationError,
  requireMembership,
} from "@/lib/auth/membership";
import { parseServerEnv } from "@/lib/env";
import {
  SHOPIFY_STATE_COOKIE,
  createShopifyAuthorization,
  normalizeShopDomain,
} from "@/lib/integrations/business/live/shopify/oauth";

const bodySchema = z.object({ shop: z.string().min(1).max(255) });

export async function POST(request: Request) {
  try {
    const membership = await requireMembership(["owner"]);
    const env = parseServerEnv(process.env);
    if (!env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET || !env.CREDENTIAL_ENCRYPTION_KEY) {
      return fail("shopify_not_configured", "Shopify integration is not configured", 503, false);
    }
    const body = await parseBody(request, bodySchema);
    if (!body.success) return body.response;
    const shop = normalizeShopDomain(body.data.shop);
    if (!shop) {
      return fail("invalid_shop", "Enter your store's myshopify.com domain", 422, false, [
        { field: "shop", message: "Must look like your-store.myshopify.com" },
      ]);
    }
    const origin = env.APP_BASE_URL ? new URL(env.APP_BASE_URL).origin : new URL(request.url).origin;
    const { url, nonce } = createShopifyAuthorization({
      shop,
      orgId: membership.orgId,
      userId: membership.userId,
      clientId: env.SHOPIFY_CLIENT_ID,
      redirectUri: new URL("/api/auth/shopify/callback", origin).toString(),
      signingKey: env.CREDENTIAL_ENCRYPTION_KEY,
      now: () => new Date(),
    });
    const response = ok({ authorization_url: url });
    response.headers.append(
      "set-cookie",
      `${SHOPIFY_STATE_COOKIE}=${nonce}; Path=/api/auth/shopify; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    );
    return response;
  } catch (err) {
    if (err instanceof AuthenticationError) return fail("unauthenticated", err.message, 401, false);
    if (err instanceof AuthorizationError) return fail("forbidden", err.message, 403, false);
    throw err;
  }
}
