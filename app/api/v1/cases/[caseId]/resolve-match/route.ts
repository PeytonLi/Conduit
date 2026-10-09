import { createHash } from "node:crypto";
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
import { createDeepSeekClient } from "@/lib/agent/extraction";
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
    const deepseek = createDeepSeekClient(env);

    const requestKey = `resolve:${caseId}:${key}`;
    const requestHash = createHash("sha256")
      .update(JSON.stringify(parsed.data))
      .digest("hex");
    const stored = await rpc.rpc<{
      replayed: boolean;
      response: unknown;
    }>("inbox_request_key_store", {
      org_id: membership.orgId,
      idempotency_key: requestKey,
      request_hash: requestHash,
    });
    if (stored.replayed && stored.response) {
      return ok(stored.response as Record<string, unknown>);
    }

    const result = await resolveMessageMatch({
      rpc,
      orgId: membership.orgId,
      caseId,
      actorUserId: membership.userId,
      input: parsed.data,
      deps: {
        mode: env.APP_ENV,
        deepseek: deepseek ?? undefined,
        model: env.DEEPSEEK_MODEL,
      },
      now: () => new Date(),
    });
    const response = {
      case_id: caseId,
      status: result.status,
      case_ids: result.case_ids,
      review_id: result.review_id,
      extraction_version: result.extraction_version,
      mode: env.APP_ENV,
    };
    await rpc.rpc("inbox_request_key_complete", {
      org_id: membership.orgId,
      idempotency_key: requestKey,
      response,
    });
    return ok(response);
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
