import { fail, ok } from "@/lib/api/http";
import { AuthenticationError, AuthorizationError, requireMembership } from "@/lib/auth/membership";
import { sameOriginAllowed } from "@/lib/db/queries/idempotency";
import { parseServerEnv } from "@/lib/env";
import { ErpNotConfiguredError, storeErpConnection } from "@/lib/integrations/business/live/connections";
import { odooCredentialsSchema, odooUrlAllowed, verifyOdooConnection } from "@/lib/integrations/business/live/odoo";

const NOT_CONFIGURED = () => fail("business_not_configured", "Business connections are not configured", 503, false);

export async function POST(request: Request): Promise<Response> {
  if (!sameOriginAllowed(request)) return fail("origin_rejected", "Request origin is not allowed", 403, false);
  let membership;
  try {
    membership = await requireMembership(["owner"]);
  } catch (error) {
    if (error instanceof AuthenticationError) return fail("authentication_required", "Authentication is required", 401, false);
    if (error instanceof AuthorizationError) return fail("membership_required", "Only an owner can connect Odoo", 403, false);
    throw error;
  }

  if (!parseServerEnv(process.env).CREDENTIAL_ENCRYPTION_KEY) return NOT_CONFIGURED();

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail("validation_failed", "Request body is invalid", 422, false);
  }
  const parsed = odooCredentialsSchema.safeParse(raw);
  if (!parsed.success) return fail("validation_failed", "Enter the Odoo address, database, username and API key", 422, false);
  if (!odooUrlAllowed(parsed.data.url, process.env.NODE_ENV === "production")) {
    return fail("url_not_allowed", "Use the public https address of your Odoo", 422, false);
  }

  const verified = await verifyOdooConnection(parsed.data);
  if (!verified.ok) {
    const unreachable = verified.code === "unreachable";
    return fail(`odoo_${verified.code}`, verified.message, unreachable ? 502 : 422, unreachable);
  }

  try {
    await storeErpConnection({
      orgId: membership.orgId,
      actorUserId: membership.userId,
      provider: "odoo",
      externalAccountId: verified.externalAccountId,
      scopes: ["purchase", "stock", "sale"],
      credentials: parsed.data,
      expiresAt: null,
    });
  } catch (error) {
    if (error instanceof ErpNotConfiguredError) return NOT_CONFIGURED();
    return fail("connection_store_failed", "The Odoo connection could not be saved", 503, true);
  }
  return ok({ connected: true });
}
