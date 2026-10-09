import { AuthenticationError, AuthorizationError, requireMembership } from "@/lib/auth";
import { fail } from "@/lib/api/http";
import { z } from "zod";

export const importMetadataSchema = z.object({
  schema_version: z.literal(1),
  source_as_of: z.string().min(1),
  timezone: z.string().min(1),
  currency: z.string().regex(/^[A-Z]{3}$/),
});

export async function membershipOrResponse() {
  try {
    return {
      membership: await requireMembership(["owner", "operator"]),
      response: null,
    };
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return {
        membership: null,
        response: fail("unauthenticated", "Authentication required", 401, false),
      };
    }
    if (error instanceof AuthorizationError) {
      return {
        membership: null,
        response: fail("forbidden", "Membership role is not permitted", 403, false),
      };
    }
    return {
      membership: null,
      response: fail("internal_error", "The request could not be completed", 500, true),
    };
  }
}

export function originFailure(request: Request): Response | null {
  const origin = request.headers.get("Origin");
  if (!origin) return null;

  let suppliedOrigin: string;
  try {
    suppliedOrigin = new URL(origin).origin;
  } catch {
    return fail("origin_mismatch", "Request origin is not allowed", 403, false);
  }

  const allowedOrigins = new Set<string>();
  try {
    allowedOrigins.add(new URL(request.url).origin);
  } catch {
    return fail("origin_mismatch", "Request origin is not allowed", 403, false);
  }
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",", 1)[0].trim();
  const requestHost = forwardedHost || request.headers.get("host");
  if (requestHost) {
    const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",", 1)[0].trim();
    const requestProtocol = forwardedProtocol || new URL(request.url).protocol.slice(0, -1);
    allowedOrigins.add(`${requestProtocol}://${requestHost}`);
  }

  const appBaseUrl = process.env.APP_BASE_URL?.trim();
  if (appBaseUrl) {
    try {
      allowedOrigins.add(new URL(appBaseUrl).origin);
    } catch {
      return fail("origin_mismatch", "Request origin is not allowed", 403, false);
    }
  }

  return allowedOrigins.has(suppliedOrigin)
    ? null
    : fail("origin_mismatch", "Request origin is not allowed", 403, false);
}
