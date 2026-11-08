import { publishPending, serverLedger } from "@/lib/actions/server";
import { supabaseRpcClient } from "@/lib/db/messages";
import { createServiceClient } from "@/lib/db/service";
import { parseServerEnv } from "@/lib/env";
import {
  createGoogleIdTokenVerifier,
  handleGmailPushWebhook,
} from "@/lib/integrations/gmail/push";
import { findPushConnections, syncGmailConnectionById } from "@/lib/integrations/gmail/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const verifyIdToken = createGoogleIdTokenVerifier();

/**
 * Cloud Pub/Sub push endpoint for Gmail notifications. Authenticated with the
 * subscription's Google-signed OIDC token; the notification only says "this
 * mailbox changed", so the actual work is the same history-cursor sync the
 * 10-minute poll runs.
 */
export async function POST(request: Request) {
  const rawBody = await request.text();
  try {
    const env = parseServerEnv(process.env);
    const rpc = supabaseRpcClient(createServiceClient());
    const result = await handleGmailPushWebhook(rawBody, request.headers.get("authorization"), {
      env,
      verify: verifyIdToken,
      findConnections: (email) => findPushConnections(rpc, email),
      syncConnection: (connection) =>
        syncGmailConnectionById({
          rpc,
          env,
          orgId: connection.orgId,
          connectionId: connection.connectionId,
          publish: () => publishPending(serverLedger()),
        }),
    });
    return Response.json(result.body, { status: result.status });
  } catch {
    // Nothing durable happened yet: a 5xx makes Pub/Sub redeliver; the poll is the fallback.
    return Response.json({ ok: false, code: "push_unavailable" }, { status: 500 });
  }
}
