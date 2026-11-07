import "server-only";
import { randomUUID } from "node:crypto";
import type { Rpc } from "@/lib/actions/rpc";
import { createServiceRpc } from "@/lib/actions/rpc.supabase";
import { parseServerEnv } from "@/lib/env";
import { inngest } from "@/lib/workflows/client";
import {
  encryptCredential,
  credentialKeyVersion,
} from "@/lib/integrations/gmail/crypto";
import { erpProviders, type ErpProvider } from "./registry";
import { ErpNotConfiguredError } from "./errors";

export { ErpNotConfiguredError };

export interface StoreErpConnectionInput {
  orgId: string;
  actorUserId: string;
  provider: ErpProvider;
  externalAccountId: string;
  scopes: string[];
  /** Provider-specific JSON; parsed by the provider's createClient. */
  credentials: unknown;
  expiresAt: string | null;
}

export interface StoreErpConnectionDeps {
  rpc?: Rpc;
  encryptionKey?: string | null;
  requestSync?: (orgId: string, connectionId: string) => Promise<void>;
}

/** Encrypts and stores an org's business-system credential, retiring any other ERP connection. */
export async function storeErpConnection(
  input: StoreErpConnectionInput,
  deps: StoreErpConnectionDeps = {},
): Promise<{ connectionId: string }> {
  if (!erpProviders.includes(input.provider)) {
    throw new ErpNotConfiguredError(`Unknown business provider ${input.provider}`);
  }
  const key =
    deps.encryptionKey !== undefined
      ? deps.encryptionKey
      : parseServerEnv(process.env).CREDENTIAL_ENCRYPTION_KEY;
  if (!key) throw new ErpNotConfiguredError("CREDENTIAL_ENCRYPTION_KEY is not set");
  const rpc = deps.rpc ?? createServiceRpc();
  const result = (await rpc("erp_store_connection", { p: {
    org_id: input.orgId,
    actor_user_id: input.actorUserId,
    provider: input.provider,
    external_account_id: input.externalAccountId,
    scopes: input.scopes,
    encrypted_b64: encryptCredential(JSON.stringify(input.credentials), key),
    key_version: credentialKeyVersion(key),
    expires_at: input.expiresAt,
  } })) as { connection_id: string };
  const requestSync = deps.requestSync ?? requestErpSync;
  try {
    await requestSync(input.orgId, result.connection_id);
  } catch {
    // The stored connection is valid; a later sync or the next write refreshes it.
  }
  return { connectionId: result.connection_id };
}

export async function requestErpSync(orgId: string, connectionId: string): Promise<void> {
  const eventId = randomUUID();
  await inngest.send({
    id: `business.sync.requested:${connectionId}:${eventId}`,
    name: "business.sync.requested",
    data: { org_id: orgId, connection_id: connectionId, event_id: eventId, correlation_id: eventId },
  });
}

export async function disconnectErpConnection(
  input: { orgId: string; actorUserId: string; provider?: ErpProvider },
  deps: { rpc?: Rpc } = {},
): Promise<{ disconnected: boolean }> {
  const rpc = deps.rpc ?? createServiceRpc();
  const result = (await rpc("erp_disconnect", {
    p: { org_id: input.orgId, actor_user_id: input.actorUserId, provider: input.provider ?? null },
  })) as { disconnected: boolean };
  return { disconnected: result.disconnected };
}
