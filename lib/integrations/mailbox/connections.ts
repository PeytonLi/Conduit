import { z } from "zod";
import { RpcError, type RpcClient } from "@/lib/db/messages";
import { QueryError } from "@/lib/db/queries/client";
import type { ServerEnv } from "@/lib/env";
import { revokeGmailCredential } from "@/lib/integrations/gmail/revoke";
import { isMailboxProvider } from "./types";

export const mailboxConnectionIdSchema = z.string().uuid();

interface LoadedMailbox {
  provider: string;
  status: string;
}

async function loadMailbox(
  rpc: RpcClient,
  orgId: string,
  connectionId: string,
): Promise<LoadedMailbox> {
  try {
    const loaded = await rpc.rpc<LoadedMailbox>("mailbox_load_credential", {
      org_id: orgId,
      connection_id: connectionId,
    });
    if (!isMailboxProvider(loaded.provider)) throw new RpcError("P0404", "not a mailbox");
    return loaded;
  } catch (err) {
    if (err instanceof RpcError && err.status === 404) {
      throw new QueryError("mailbox_not_found", 404, "Mailbox connection was not found");
    }
    throw err;
  }
}

/**
 * Disconnects one mailbox of the organization, whatever its provider and
 * health. Provider-side revocation is best effort and happens first: Gmail
 * tokens are revoked at Google; Microsoft has no per-token revocation endpoint,
 * so an Outlook disconnect deletes the stored token and the owner removes the
 * app under "My Account > Apps" if they want it gone on Microsoft's side too.
 */
export async function disconnectMailboxConnection({
  rpc,
  env,
  orgId,
  actorUserId,
  connectionId,
}: {
  rpc: RpcClient;
  env: Pick<ServerEnv, "CREDENTIAL_ENCRYPTION_KEY" | "COMPOSIO_API_KEY">;
  orgId: string;
  actorUserId: string;
  connectionId: string;
}): Promise<unknown> {
  const mailbox = await loadMailbox(rpc, orgId, connectionId);
  if (mailbox.provider === "gmail" && mailbox.status !== "disconnected") {
    await revokeGmailCredential({ rpc, env, orgId, connectionId });
  }
  return rpc.rpc("ui_disconnect_connection", {
    org_id: orgId,
    actor_user_id: actorUserId,
    connection_id: connectionId,
  });
}

/** Makes one active mailbox the default for outbound supplier email. */
export async function setPrimaryMailbox({
  rpc,
  orgId,
  actorUserId,
  connectionId,
}: {
  rpc: RpcClient;
  orgId: string;
  actorUserId: string;
  connectionId: string;
}): Promise<{ connection_id: string; changed: boolean }> {
  const result = await rpc.rpc<{
    ok: boolean;
    changed?: boolean;
    connection_id?: string;
  }>("mailbox_set_primary", {
    org_id: orgId,
    actor_user_id: actorUserId,
    connection_id: connectionId,
  });
  if (!result.ok) {
    throw new QueryError(
      "mailbox_not_connected",
      409,
      "Only a connected mailbox can be the primary mailbox",
    );
  }
  return { connection_id: connectionId, changed: result.changed === true };
}
