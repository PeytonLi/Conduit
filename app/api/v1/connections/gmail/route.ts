import { QueryError } from "@/lib/db/queries/client";
import {
  executeMutation,
  mutationGuard,
  withMembership,
} from "@/lib/db/queries/route-helpers";
import { createServiceClient } from "@/lib/db/service";
import { supabaseRpcClient } from "@/lib/db/messages";
import { parseServerEnv } from "@/lib/env";
import { revokeGmailCredential } from "@/lib/integrations/gmail/revoke";

/**
 * Disconnects the organization's most recently updated active Gmail
 * connection. Per-connection disconnect, for any mailbox provider, lives at
 * /api/v1/connections/mailboxes/{connectionId}.
 */
export async function DELETE(request: Request): Promise<Response> {
  const guard = mutationGuard(request);
  if (guard) return guard;
  return withMembership(
    async (context) => executeMutation(request, context, {}, async () => {
      const client = createServiceClient();
      const rpc = supabaseRpcClient(client);
      const { data: connection, error } = await client
        .from("connections")
        .select("id")
        .eq("org_id", context.orgId)
        .eq("provider", "gmail")
        .in("status", ["healthy", "degraded"])
        .order("updated_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) {
        throw new QueryError("connection_query_failed", 503, "Gmail connection is unavailable");
      }

      if (connection) {
        await revokeGmailCredential({
          rpc,
          env: parseServerEnv(process.env),
          orgId: context.orgId,
          connectionId: connection.id,
        });
      }

      const result = await rpc.rpc("ui_disconnect_connection", {
        org_id: context.orgId,
        actor_user_id: context.userId,
        connection_id: connection?.id ?? null,
      });
      return { data: result };
    }),
    ["owner"],
  );
}
