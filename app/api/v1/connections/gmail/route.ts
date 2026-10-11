import { google } from "googleapis";
import { QueryError } from "@/lib/db/queries/client";
import {
  executeMutation,
  mutationGuard,
  withMembership,
} from "@/lib/db/queries/route-helpers";
import { createServiceClient } from "@/lib/db/service";
import { supabaseRpcClient } from "@/lib/db/messages";
import { parseServerEnv } from "@/lib/env";
import { createComposioClient } from "@/lib/integrations/gmail/composio-client";
import { decryptCredential } from "@/lib/integrations/gmail/crypto";
import { parseGmailCredential } from "@/lib/integrations/gmail/credentials";

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
        try {
          const credential = await rpc.rpc<{
            encrypted_b64: string | null;
            key_version: string | null;
          }>("gmail_load_credential", {
            org_id: context.orgId,
            connection_id: connection.id,
          });
          const env = parseServerEnv(process.env);
          if (
            !credential.encrypted_b64 ||
            !credential.key_version ||
            !env.CREDENTIAL_ENCRYPTION_KEY
          ) {
            throw new Error("Stored Gmail credential is unavailable");
          }
          const stored = parseGmailCredential(
            decryptCredential(
              credential.encrypted_b64,
              env.CREDENTIAL_ENCRYPTION_KEY,
              credential.key_version,
            ),
          );
          if (stored.provider === "composio") {
            if (!env.COMPOSIO_API_KEY) throw new Error("Composio is not configured");
            await createComposioClient(env.COMPOSIO_API_KEY).connectedAccounts.delete(
              stored.connectedAccountId,
            );
          } else {
            await new google.auth.OAuth2().revokeToken(stored.refreshToken);
          }
        } catch {
          console.warn("[gmail] provider revocation failed", { org_id: context.orgId });
        }
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
