import { google } from "googleapis";
import type { RpcClient } from "@/lib/db/messages";
import type { ServerEnv } from "@/lib/env";
import { createComposioClient } from "./composio-client";
import { parseGmailCredential } from "./credentials";
import { decryptCredential } from "./crypto";

/**
 * Best-effort provider-side revocation of a stored Gmail credential. A failure
 * is logged and swallowed: the local disconnect must still go through.
 */
export async function revokeGmailCredential({
  rpc,
  env,
  orgId,
  connectionId,
}: {
  rpc: RpcClient;
  env: Pick<ServerEnv, "CREDENTIAL_ENCRYPTION_KEY" | "COMPOSIO_API_KEY">;
  orgId: string;
  connectionId: string;
}): Promise<void> {
  try {
    const credential = await rpc.rpc<{
      encrypted_b64: string | null;
      key_version: string | null;
    }>("mailbox_load_credential", { org_id: orgId, connection_id: connectionId });
    if (!credential.encrypted_b64 || !credential.key_version || !env.CREDENTIAL_ENCRYPTION_KEY) {
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
    console.warn("[gmail] provider revocation failed", { org_id: orgId });
  }
}
