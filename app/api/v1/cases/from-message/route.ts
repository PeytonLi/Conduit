import { createHash } from "node:crypto";
import { z } from "zod";
import { ok, fail, parseBody, idempotencyKey } from "@/lib/api/http";
import {
  AuthenticationError,
  AuthorizationError,
  requireMembership,
} from "@/lib/auth/membership";
import { createServiceClient } from "@/lib/db/service";
import {
  ensureInboxConnection,
  ingestMessage,
  loadMessage,
  supabaseRpcClient,
} from "@/lib/db/messages";
import { processSourceMessage } from "@/lib/db/cases-open";
import { createDeepSeekClient } from "@/lib/agent/extraction";
import { RpcError } from "@/lib/db/messages";
import { parseServerEnv } from "@/lib/env";

const bodySchema = z.union([
  z
    .object({
      source_text: z.string().min(1).max(100000),
      sender: z.string().email(),
      subject: z.string().max(500).optional(),
      sent_at: z.string().datetime().optional(),
    })
    .strict(),
  z
    .object({
      message_id: z.string().uuid(),
    })
    .strict(),
]);

function syntheticRaw(input: {
  source_text: string;
  sender: string;
  subject?: string;
  sent_at?: string;
}): string {
  const headers = [
    `From: ${input.sender.replace(/[\r\n]+/g, " ")}`,
    `Subject: ${(input.subject ?? "Pasted supplier message").replace(/[\r\n]+/g, " ")}`,
    `Date: ${new Date(input.sent_at ?? Date.now()).toUTCString()}`,
    `Message-ID: <paste.${createHash("sha256").update(input.source_text).digest("hex").slice(0, 16)}@manual>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
  ];
  return `${headers.join("\r\n")}\r\n\r\n${input.source_text}`;
}

export async function POST(request: Request) {
  try {
    const membership = await requireMembership(["owner", "operator"]);
    const key = idempotencyKey(request);
    if (!key) {
      return fail("missing_idempotency_key", "Idempotency-Key header is required", 422, false);
    }
    const parsed = await parseBody(request, bodySchema);
    if (!parsed.success) return parsed.response;

    const env = parseServerEnv(process.env);
    const mode = env.APP_ENV;
    const deepseek = createDeepSeekClient(env);
    const extractDeps = {
      mode,
      deepseek: deepseek ?? undefined,
      model: env.DEEPSEEK_MODEL,
    };
    const client = createServiceClient();
    const rpc = supabaseRpcClient(client);
    const body = parsed.data;

    const requestHash = createHash("sha256")
      .update(JSON.stringify(body))
      .digest("hex");

    let sourceMessageId: string;
    let requestKey: string | null = null;
    if ("message_id" in body) {
      requestKey = `message:${key}`;
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
      // Must belong to this org (404 otherwise).
      const loaded = await loadMessage(rpc, membership.orgId, body.message_id);
      sourceMessageId = loaded.message.id;
    } else {
      const connectionId = await ensureInboxConnection(
        rpc,
        membership.orgId,
        "manual_paste",
      );
      const stored = await rpc.rpc<{ replayed: boolean; source_message_id: string | null; response: unknown }>(
        "inbox_request_key_store",
        {
          org_id: membership.orgId,
          idempotency_key: key,
          request_hash: requestHash,
        },
      );
      if (stored.replayed && stored.source_message_id) {
        const result = await processSourceMessage({
          rpc,
          orgId: membership.orgId,
          sourceMessageId: stored.source_message_id,
          mode: "auto",
          deps: extractDeps,
          now: () => new Date(),
        });
        return ok({
          source_message_id: stored.source_message_id,
          status: result.status,
          case_ids: result.case_ids,
          review_id: result.review_id,
          mode,
        });
      }
      const ingested = await ingestMessage({
        rpc,
        orgId: membership.orgId,
        connectionId,
        providerMessageId: `paste:${key}`,
        providerThreadId: null,
        raw: syntheticRaw(body),
        historical: false,
        direction: "inbound",
      });
      sourceMessageId = ingested.source_message_id;
    }

    const result = await processSourceMessage({
      rpc,
      orgId: membership.orgId,
      sourceMessageId,
      mode: "auto",
      deps: extractDeps,
      now: () => new Date(),
    });

    const response = {
      source_message_id: sourceMessageId,
      status: result.status,
      case_ids: result.case_ids,
      review_id: result.review_id,
      mode,
    };
    await rpc.rpc("inbox_request_key_complete", {
      org_id: membership.orgId,
      idempotency_key: requestKey ?? key,
      source_message_id: sourceMessageId,
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
    if (err instanceof RpcError) {
      return fail(err.code, err.message, err.status, err.status >= 500);
    }
    throw err;
  }
}
