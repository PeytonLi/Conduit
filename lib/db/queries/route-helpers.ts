import { AuthenticationError, AuthorizationError, requireMembership } from "@/lib/auth/membership";
import type { MembershipRole } from "@/lib/db/queries/derive";
import { QueryError, type QueryContext } from "@/lib/db/queries/client";
import {
  sameOriginAllowed,
  withIdempotency,
} from "@/lib/db/queries/idempotency";
import { createServerClient } from "@/lib/db/server";
import { fail, idempotencyKey, ok } from "@/lib/api/http";
import { z } from "zod";

export async function withMembership(
  handler: (context: QueryContext) => Promise<Response>,
  roles?: readonly MembershipRole[],
): Promise<Response> {
  try {
    const membership = await requireMembership(roles);
    const client = await createServerClient();
    return await handler({ ...membership, client });
  } catch (error) {
    return errorResponse(error);
  }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof AuthenticationError) {
    return fail("authentication_required", "Authentication is required", 401, false);
  }
  if (error instanceof AuthorizationError) {
    return fail("membership_required", "An active organization membership is required", 403, false);
  }
  if (error instanceof QueryError) {
    return fail(
      error.code,
      error.message,
      error.status,
      error.status >= 500 || error.code === "idempotency_in_progress",
    );
  }
  return fail("internal_error", "The request could not be completed", 500, true);
}

export function parseQuery<T extends z.ZodType>(
  request: Request,
  schema: T,
): { success: true; data: z.infer<T> } | { success: false; response: Response } {
  const params = new URL(request.url).searchParams;
  const input: Record<string, unknown> = Object.fromEntries(params.entries());
  for (const key of ["phase", "severity"]) {
    const values = params.getAll(key).flatMap((value) => value.split(",")).filter(Boolean);
    if (values.length > 0) input[key] = values;
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      response: fail(
        "validation_failed",
        "Query parameters are invalid",
        422,
        false,
        parsed.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      ),
    };
  }
  return { success: true, data: parsed.data };
}

export function mutationGuard(request: Request): Response | null {
  if (!sameOriginAllowed(request)) {
    return fail("origin_rejected", "Request origin is not allowed", 403, false);
  }
  if (!idempotencyKey(request)) {
    return fail("idempotency_key_required", "Idempotency-Key is required", 422, false);
  }
  return null;
}

export async function executeMutation<T>(
  request: Request,
  context: QueryContext,
  body: unknown,
  run: (requestId: string) => Promise<{ data: T; status?: number }>,
): Promise<Response> {
  const guard = mutationGuard(request);
  if (guard) return guard;
  try {
    const key = idempotencyKey(request);
    const stored = await withIdempotency(
      context.orgId,
      key,
      new URL(request.url).pathname,
      body,
      async () => {
        const result = await run(crypto.randomUUID());
        const status = result.status ?? 200;
        const response = ok(result.data, status);
        return { status, body: await response.json() };
      },
      { actorUserId: context.userId },
    );
    return Response.json(stored.body, { status: stored.status });
  } catch (error) {
    return errorResponse(error);
  }
}
