import type { RpcClient } from "@/lib/db/messages";
import type { ServerEnv } from "@/lib/env";
import type { GmailApi } from "@/lib/integrations/gmail/api";
import { parseGmailCredential, type GmailCredential } from "@/lib/integrations/gmail/credentials";
import { decryptCredential } from "@/lib/integrations/gmail/crypto";
import { createGmailApiFromCredential } from "@/lib/integrations/gmail/runtime";
import { parseOutlookCredential } from "@/lib/integrations/outlook/credentials";
import type { FetchLike } from "@/lib/integrations/outlook/http";
import { createOutlookApiForConnection } from "@/lib/integrations/outlook/runtime";
import { isActiveMailboxStatus, isMailboxProvider, type MailboxProvider } from "./types";
import type { SupplierEmailTransport } from "./transport";

export const FALLBACK_FROM_ADDRESS = "inbox@conduit.local";

interface StoredMailboxCredential {
  provider: string;
  status: string;
  external_account_id: string | null;
  encrypted_b64: string | null;
  key_version: string | null;
}

export interface ResolvedMailboxTransport {
  provider: MailboxProvider;
  transport: SupplierEmailTransport;
  fromAddress: string;
}

export interface ResolveMailboxTransportArgs {
  rpc: RpcClient;
  env: ServerEnv;
  orgId: string;
  connectionId: string;
  /** Test seams; the defaults build the real provider clients. */
  createGmailApi?: (
    env: ServerEnv,
    credential: GmailCredential,
    ctx: { orgId: string },
  ) => GmailApi | null;
  fetchImpl?: FetchLike;
}

/**
 * Turns the connection an outbound action names into a send transport.
 *
 * The credential is loaded by (org_id, connection_id), so a connection id from
 * another organization resolves to nothing. The provider comes from the stored
 * row, not from the caller, and there is no fallback to a different mailbox:
 * an unusable connection yields null and the dispatch fails visibly.
 */
export async function resolveMailboxTransport(
  args: ResolveMailboxTransportArgs,
): Promise<ResolvedMailboxTransport | null> {
  const { rpc, env, orgId, connectionId } = args;
  if (!env.CREDENTIAL_ENCRYPTION_KEY) return null;

  let stored: StoredMailboxCredential;
  try {
    stored = await rpc.rpc<StoredMailboxCredential>("mailbox_load_credential", {
      org_id: orgId,
      connection_id: connectionId,
    });
  } catch {
    return null;
  }
  if (
    !isMailboxProvider(stored.provider) ||
    !isActiveMailboxStatus(stored.status) ||
    !stored.encrypted_b64 ||
    !stored.key_version
  ) {
    return null;
  }

  let plaintext: string;
  try {
    plaintext = decryptCredential(stored.encrypted_b64, env.CREDENTIAL_ENCRYPTION_KEY, stored.key_version);
  } catch {
    return null;
  }

  if (stored.provider === "outlook") {
    let credential;
    try {
      credential = parseOutlookCredential(plaintext);
    } catch {
      return null;
    }
    const api = createOutlookApiForConnection({
      rpc,
      env,
      orgId,
      connectionId,
      credential,
      fetchImpl: args.fetchImpl,
    });
    if (!api) return null;
    return {
      provider: "outlook",
      transport: api,
      fromAddress: stored.external_account_id ?? FALLBACK_FROM_ADDRESS,
    };
  }

  const credential = parseGmailCredential(plaintext);
  const api = (args.createGmailApi ?? createGmailApiFromCredential)(env, credential, { orgId });
  if (!api) return null;
  return {
    provider: "gmail",
    transport: api,
    fromAddress:
      credential.provider === "composio"
        ? FALLBACK_FROM_ADDRESS
        : (stored.external_account_id ?? FALLBACK_FROM_ADDRESS),
  };
}
