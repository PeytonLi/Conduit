import { ingestMessage, type RpcClient } from "@/lib/db/messages";
import type { ServerEnv } from "@/lib/env";
import { safeErrorLogFields } from "@/lib/safe-error";
import {
  credentialKeyVersion,
  decryptCredential,
  encryptCredential,
} from "@/lib/integrations/gmail/crypto";
import type { SyncResult, SyncStore } from "@/lib/integrations/gmail/sync";
import { createGraphOutlookApi, type OutlookApi } from "./api";
import { outlookConfig, type OutlookConfig } from "./config";
import {
  parseOutlookCredential,
  serializeOutlookCredential,
  type OutlookCredential,
} from "./credentials";
import { createMicrosoftFetch, type FetchLike } from "./http";
import { refreshOutlookAccessToken } from "./oauth";
import { syncOutlookConnection } from "./sync";

/**
 * Server-side Outlook plumbing shared by the Inngest poller and the supplier
 * email adapter. Everything is org-scoped through the (org_id, connection_id)
 * pair, and every Microsoft call goes through createMicrosoftFetch, which
 * throws before any network I/O in replay.
 */

interface StoredMailboxCredential {
  provider: string;
  status: string;
  external_account_id: string | null;
  sync_cursor: string | null;
  encrypted_b64: string | null;
  key_version: string | null;
}

export interface LoadedOutlookConnection {
  credential: OutlookCredential;
  status: string;
  mailboxAddress: string | null;
}

/** Loads and decrypts the Outlook credential of one connection; null when unusable. */
export async function loadOutlookConnection(
  rpc: RpcClient,
  env: Pick<ServerEnv, "CREDENTIAL_ENCRYPTION_KEY">,
  orgId: string,
  connectionId: string,
): Promise<LoadedOutlookConnection | null> {
  const stored = await rpc.rpc<StoredMailboxCredential>("mailbox_load_credential", {
    org_id: orgId,
    connection_id: connectionId,
  });
  if (stored.provider !== "outlook") return null;
  if (!stored.encrypted_b64 || !stored.key_version || !env.CREDENTIAL_ENCRYPTION_KEY) return null;
  try {
    return {
      credential: parseOutlookCredential(
        decryptCredential(stored.encrypted_b64, env.CREDENTIAL_ENCRYPTION_KEY, stored.key_version),
      ),
      status: stored.status,
      mailboxAddress: stored.external_account_id,
    };
  } catch {
    return null;
  }
}

export interface OutlookApiDeps {
  rpc: RpcClient;
  env: ServerEnv;
  orgId: string;
  connectionId: string;
  /** Test seam. The default is the global fetch behind the replay guard. */
  fetchImpl?: FetchLike;
  now?: () => Date;
}

/**
 * Builds the Graph API for one connection, or null when Outlook is not
 * configured or the app runs in replay. The access token is refreshed on demand
 * and a rotated refresh token is persisted for the next run.
 */
export function createOutlookApiForConnection(
  deps: OutlookApiDeps & { credential: OutlookCredential },
): OutlookApi | null {
  const { rpc, env, orgId, connectionId, credential } = deps;
  if (env.APP_ENV === "replay") return null;
  const config = outlookConfig(env);
  if (!config) return null;
  const fetchImpl = createMicrosoftFetch({
    appEnv: () => env.APP_ENV,
    fetchImpl: deps.fetchImpl,
  });
  const now = deps.now ?? (() => new Date());
  return createGraphOutlookApi({
    fetchImpl,
    getAccessToken: createAccessTokenProvider({
      config,
      credential,
      fetchImpl,
      now,
      persistRotation: (rotated) => persistRotatedCredential(rpc, config, orgId, connectionId, rotated),
    }),
  });
}

/** Caches the access token until a minute before it expires. */
export function createAccessTokenProvider({
  config,
  credential,
  fetchImpl,
  now,
  persistRotation,
}: {
  config: OutlookConfig;
  credential: OutlookCredential;
  fetchImpl: FetchLike;
  now: () => Date;
  persistRotation: (credential: OutlookCredential, expiresAt: Date) => Promise<void>;
}): () => Promise<string> {
  let refreshToken = credential.refreshToken;
  let cached: { token: string; expiresAt: number } | null = null;
  return async () => {
    if (cached && cached.expiresAt - 60_000 > now().getTime()) return cached.token;
    const refreshed = await refreshOutlookAccessToken({ config, refreshToken, fetchImpl, now });
    cached = { token: refreshed.accessToken, expiresAt: refreshed.expiresAt.getTime() };
    if (refreshed.refreshToken !== refreshToken) {
      refreshToken = refreshed.refreshToken;
      try {
        await persistRotation(
          { provider: "outlook", refreshToken: refreshed.refreshToken },
          refreshed.expiresAt,
        );
      } catch (err) {
        // The previous token normally stays valid; keep working this run and
        // let the next refresh try to store the new one again.
        console.error("outlook credential rotation not stored", safeErrorLogFields(err));
      }
    }
    return refreshed.accessToken;
  };
}

async function persistRotatedCredential(
  rpc: RpcClient,
  config: OutlookConfig,
  orgId: string,
  connectionId: string,
  credential: OutlookCredential,
): Promise<void> {
  await rpc.rpc("mailbox_update_credential", {
    org_id: orgId,
    connection_id: connectionId,
    encrypted_b64: encryptCredential(serializeOutlookCredential(credential), config.signingKey),
    key_version: credentialKeyVersion(config.signingKey),
    expires_at: null,
  });
}

/** Cursor, status and ingest operations for any mailbox connection over the neutral RPCs. */
export function createMailboxRpcSyncStore(rpc: RpcClient): SyncStore {
  return {
    // Re-read the cursor so the CAS compares against fresh state.
    getCursor: async (orgId, connectionId) => {
      const fresh = await rpc.rpc<{ sync_cursor: string | null }>("mailbox_load_credential", {
        org_id: orgId,
        connection_id: connectionId,
      });
      return fresh.sync_cursor;
    },
    storeMessage: async (m) => {
      const r = await ingestMessage({
        rpc,
        orgId: m.orgId,
        connectionId: m.connectionId,
        providerMessageId: m.providerMessageId,
        providerThreadId: m.providerThreadId,
        raw: m.raw,
        historical: m.historical,
        direction: m.direction,
      });
      return r.created;
    },
    setStatus: async (orgId, connectionId, status, code) => {
      await rpc.rpc("mailbox_set_status", {
        org_id: orgId,
        connection_id: connectionId,
        status,
        error_code: code,
      });
    },
    advanceCursor: async (orgId, connectionId, expected, next) => {
      const r = await rpc.rpc<{ advanced: boolean }>("mailbox_advance_cursor", {
        org_id: orgId,
        connection_id: connectionId,
        expected_cursor: expected,
        new_cursor: next,
      });
      return r.advanced;
    },
  };
}

export interface SyncOutlookByIdArgs extends Omit<OutlookApiDeps, "fetchImpl"> {
  /** Publishes outbox events produced by ingest (supplier.message.received). */
  publish: () => Promise<void>;
  fetchImpl?: FetchLike;
}

/** The single sync entry point for the Outlook poll. */
export async function syncOutlookConnectionById(
  args: SyncOutlookByIdArgs,
): Promise<SyncResult | { ok: false; reason: string }> {
  const { rpc, env, orgId, connectionId } = args;
  if (env.APP_ENV === "replay") return { ok: false, reason: "replay mode" };
  const loaded = await loadOutlookConnection(rpc, env, orgId, connectionId);
  if (!loaded) return { ok: false, reason: "missing credential" };
  const api = createOutlookApiForConnection({ ...args, credential: loaded.credential });
  if (!api) return { ok: false, reason: "outlook not configured" };
  const synced = await syncOutlookConnection({
    orgId,
    connectionId,
    api,
    mailboxAddress: loaded.mailboxAddress,
    now: args.now ?? (() => new Date()),
    store: createMailboxRpcSyncStore(rpc),
  });
  await args.publish();
  return synced;
}
