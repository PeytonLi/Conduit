import { ok, fail, parseBody, idempotencyKey } from "@/lib/api/http";
import {
  AuthenticationError,
  AuthorizationError,
  requireMembership,
} from "@/lib/auth/membership";
import { createServiceClient } from "@/lib/db/service";
import { supabaseRpcClient, RpcError } from "@/lib/db/messages";
import {
  resolveMatchInputSchema,
  resolveMessageMatch,
  ResolveError,
} from "@/lib/db/cases-open";
import { parseServerEnv } from "@/lib/env";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ caseId: string }> },
) {
  try {
    const { caseId } = await params;
    const membership = await requireMembership(["owner", "operator"]);
    const key = idempotencyKey(request);
    if (!key) {
      return fail("missing_idempotency_key", "Idempotency-Key header is required", 422, false);
    }
    const parsed = await parseBody(request, resolveMatchInputSchema);
    if (!parsed.success) return parsed.response;

    const env = parseServerEnv(process.env);
    const rpc = supabaseRpcClient(createServiceClient());

    const result = await resolveMessageMatch({
      rpc,
      orgId: membership.orgId,
      caseId,
      actorUserId: membership.userId,
      input: parsed.data,
      deps: { mode: env.APP_ENV },
      now: () => new Date(),
    });
    return ok({
      case_id: caseId,
      status: result.status,
      case_ids: result.case_ids,
      review_id: result.review_id,
      extraction_version: result.extraction_version,
      mode: env.APP_ENV,
    });
  } catch (err) {
    if (err instanceof AuthenticationError) {
      return fail("unauthenticated", err.message, 401, false);
    }
    if (err instanceof AuthorizationError) {
      return fail("forbidden", err.message, 403, false);
    }
    if (err instanceof ResolveError) {
      return fail(err.code, err.message, err.status, false);
    }
    if (err instanceof RpcError) {
      return fail(err.code, err.message, err.status, err.status >= 500);
    }
    throw err;
  }
}
