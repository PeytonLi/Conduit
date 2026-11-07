import { z } from "zod";
import type { Rpc } from "@/lib/actions/rpc";
import { credentialKeyVersion, decryptCredential, encryptCredential } from "@/lib/integrations/gmail/crypto";
import { getErpProviderDefinition, isErpProvider, type ErpProvider } from "./registry";
import type { ErpClient } from "./types";

const loadedConnectionSchema = z.object({
  connection_id: z.string().uuid(),
  provider: z.string(),
  status: z.string(),
  external_account_id: z.string().nullable(),
  sync_cursor: z.string().nullable(),
  last_success_at: z.string().nullable(),
  encrypted_b64: z.string().nullable(),
  key_version: z.string().nullable(),
});

export interface ErpConnection {
  connectionId: string;
  provider: ErpProvider;
  externalAccountId: string | null;
  syncCursor: string | null;
  lastSuccessAt: string | null;
}

export type ResolvedErpClient =
  | { status: "ready"; connection: ErpConnection; client: ErpClient }
  | {
      status: "not_connected" | "not_configured" | "credential_unavailable";
      connection: ErpConnection | null;
      reason: string;
    };

export interface ResolveErpDeps {
  rpc: Rpc;
  encryptionKey: string | null | undefined;
  fetch?: typeof fetch;
  now?: () => Date;
}

export async function loadErpConnection(
  rpc: Rpc,
  orgId: string,
  connectionId?: string,
): Promise<{ connection: ErpConnection; encrypted: { b64: string; keyVersion: string } | null } | null> {
  const raw = await rpc("erp_load_connection", {
    p: { org_id: orgId, connection_id: connectionId ?? null },
  });
  if (raw === null || raw === undefined) return null;
  const row = loadedConnectionSchema.parse(raw);
  if (!isErpProvider(row.provider)) return null;
  return {
    connection: {
      connectionId: row.connection_id,
      provider: row.provider,
      externalAccountId: row.external_account_id,
      syncCursor: row.sync_cursor,
      lastSuccessAt: row.last_success_at,
    },
    encrypted:
      row.encrypted_b64 && row.key_version
        ? { b64: row.encrypted_b64, keyVersion: row.key_version }
        : null,
  };
}

/** Resolves an ErpClient for the org's active business connection; never throws for missing setup. */
export async function resolveErpClient(
  deps: ResolveErpDeps,
  orgId: string,
  connectionId?: string,
): Promise<ResolvedErpClient> {
  const loaded = await loadErpConnection(deps.rpc, orgId, connectionId);
  if (!loaded) return { status: "not_connected", connection: null, reason: "No business system is connected" };
  const { connection, encrypted } = loaded;
  const definition = getErpProviderDefinition(connection.provider);
  if (!definition) {
    return { status: "not_configured", connection, reason: `No ${connection.provider} connector is installed` };
  }
  if (!deps.encryptionKey) {
    return { status: "not_configured", connection, reason: "CREDENTIAL_ENCRYPTION_KEY is not set" };
  }
  if (!encrypted) {
    return { status: "credential_unavailable", connection, reason: "The stored credential is missing" };
  }
  let credentials: unknown;
  try {
    credentials = JSON.parse(decryptCredential(encrypted.b64, deps.encryptionKey, encrypted.keyVersion));
  } catch {
    return { status: "credential_unavailable", connection, reason: "The stored credential could not be decrypted" };
  }
  try {
    const key = deps.encryptionKey;
    const saveCredentials = (next: unknown, expiresAt: string | null) =>
      saveErpCredentials(deps.rpc, key, { orgId, connectionId: connection.connectionId, credentials: next, expiresAt });
    const client = definition.createClient(credentials, { fetch: deps.fetch, now: deps.now, saveCredentials });
    return { status: "ready", connection, client };
  } catch {
    return { status: "credential_unavailable", connection, reason: "The stored credential is not valid for this provider" };
  }
}

/** Re-encrypts and stores rotated credentials for an active connection. */
export async function saveErpCredentials(
  rpc: Rpc,
  encryptionKey: string,
  input: { orgId: string; connectionId: string; credentials: unknown; expiresAt: string | null },
): Promise<void> {
  const result = z.object({ ok: z.boolean(), code: z.string().optional() }).parse(
    await rpc("erp_update_credentials", {
      p: {
        org_id: input.orgId,
        connection_id: input.connectionId,
        encrypted_b64: encryptCredential(JSON.stringify(input.credentials), encryptionKey),
        key_version: credentialKeyVersion(encryptionKey),
        expires_at: input.expiresAt,
      },
    }),
  );
  if (!result.ok) throw new Error(`Business system credentials were not saved (${result.code ?? "unknown"})`);
}
