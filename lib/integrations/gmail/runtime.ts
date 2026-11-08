import { google } from "googleapis";
import { ingestMessage, type RpcClient } from "@/lib/db/messages";
import type { ServerEnv } from "@/lib/env";
import { safeErrorLogFields } from "@/lib/safe-error";
import { createGoogleGmailApi, type GmailApi } from "./api";
import { createComposioGmailApi } from "./composio-api";
import { createComposioClient } from "./composio-client";
import { parseGmailCredential, type GmailCredential } from "./credentials";
import { decryptCredential } from "./crypto";
import {
  gmailWatchEnabled,
  parseGmailWatchStates,
  registerGmailWatch,
  selectWatchesDue,
  type GmailWatchState,
  type PushConnection,
  type WatchRegistration,
} from "./push";
import { syncGmailConnection, type SyncResult, type SyncStore } from "./sync";

/**
 * Shared server-side Gmail plumbing used by the Inngest poller, the Pub/Sub
 * push webhook and watch renewal. Everything here is org-scoped through the
 * (org_id, connection_id) pair; nothing is read or written by connection id alone.
 */

export type CreateGmailApi = (
  credential: GmailCredential,
  ctx: { orgId: string },
) => GmailApi | null;

export function createGmailApiFromCredential(
  env: ServerEnv,
  credential: GmailCredential,
  ctx: { orgId: string },
): GmailApi | null {
  if (env.GMAIL_PROVIDER === "composio") {
    if (credential.provider !== "composio" || !env.COMPOSIO_API_KEY) return null;
    return createComposioGmailApi(
      createComposioClient(env.COMPOSIO_API_KEY),
      ctx.orgId,
      credential.connectedAccountId,
    );
  }
  if (
    credential.provider !== "google" ||
    !env.GOOGLE_CLIENT_ID ||
    !env.GOOGLE_CLIENT_SECRET ||
    !env.GOOGLE_REDIRECT_URI
  ) {
    return null;
  }
  const oauth2 = new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI,
  );
  oauth2.setCredentials({ refresh_token: credential.refreshToken });
  return createGoogleGmailApi(oauth2);
}

interface StoredCredential {
  encrypted_b64: string | null;
  key_version: string | null;
  sync_cursor: string | null;
}

async function loadCredential(
  rpc: RpcClient,
  env: ServerEnv,
  orgId: string,
  connectionId: string,
): Promise<GmailCredential | null> {
  const cred = await rpc.rpc<StoredCredential>("gmail_load_credential", {
    org_id: orgId,
    connection_id: connectionId,
  });
  if (!cred.encrypted_b64 || !cred.key_version || !env.CREDENTIAL_ENCRYPTION_KEY) return null;
  return parseGmailCredential(
    decryptCredential(cred.encrypted_b64, env.CREDENTIAL_ENCRYPTION_KEY, cred.key_version),
  );
}

export function createRpcSyncStore(rpc: RpcClient): SyncStore {
  return {
    // Re-read the cursor so the CAS compares against fresh state,
    // not the value captured before this sync started.
    getCursor: async (orgId, connectionId) => {
      const fresh = await rpc.rpc<{ sync_cursor: string | null }>("gmail_load_credential", {
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
      await rpc.rpc("gmail_set_status", {
        org_id: orgId,
        connection_id: connectionId,
        status,
        error_code: code,
      });
    },
    advanceCursor: async (orgId, connectionId, expected, next) => {
      const r = await rpc.rpc<{ advanced: boolean }>("gmail_advance_cursor", {
        org_id: orgId,
        connection_id: connectionId,
        expected_cursor: expected,
        new_cursor: next,
      });
      return r.advanced;
    },
  };
}

export interface SyncByIdArgs {
  rpc: RpcClient;
  env: ServerEnv;
  orgId: string;
  connectionId: string;
  /** Publishes outbox events produced by ingest (e.g. supplier.message.received). */
  publish: () => Promise<void>;
  now?: () => Date;
  createApi?: CreateGmailApi;
}

/** The single sync entry point for both the 10-minute poll and push notifications. */
export async function syncGmailConnectionById(
  args: SyncByIdArgs,
): Promise<SyncResult | { ok: false; reason: string }> {
  const { rpc, env, orgId, connectionId } = args;
  const credential = await loadCredential(rpc, env, orgId, connectionId);
  if (!credential) return { ok: false, reason: "missing credential" };
  const api = (args.createApi ?? ((c, ctx) => createGmailApiFromCredential(env, c, ctx)))(
    credential,
    { orgId },
  );
  if (!api) return { ok: false, reason: "provider credential mismatch" };
  const synced = await syncGmailConnection({
    orgId,
    connectionId,
    api,
    now: args.now ?? (() => new Date()),
    store: createRpcSyncStore(rpc),
  });
  await args.publish();
  return synced;
}

/** Healthy, non-replay connections for a mailbox, resolved per organization. */
export async function findPushConnections(
  rpc: RpcClient,
  emailAddress: string,
): Promise<PushConnection[]> {
  const states = parseGmailWatchStates(
    await rpc.rpc("gmail_list_watch_state", { email: emailAddress }),
  );
  return states
    .filter((s) => s.environmentMode !== "replay")
    .map((s) => ({ orgId: s.orgId, connectionId: s.connectionId }));
}

export interface WatchArgs {
  rpc: RpcClient;
  env: ServerEnv;
  now?: () => Date;
  createApi?: CreateGmailApi;
}

export type WatchOutcome = WatchRegistration | { ok: false; reason: "skipped" };

/** Calls users.watch for one connection and stores the returned expiration. */
export async function registerWatchForConnection(
  args: WatchArgs & { orgId: string; connectionId: string },
): Promise<WatchOutcome> {
  const { rpc, env, orgId, connectionId } = args;
  const topic = env.GMAIL_PUBSUB_TOPIC;
  if (!topic || !gmailWatchEnabled(env)) return { ok: false, reason: "skipped" };
  const credential = await loadCredential(rpc, env, orgId, connectionId);
  if (!credential || credential.provider !== "google") return { ok: false, reason: "skipped" };
  const api = (args.createApi ?? ((c, ctx) => createGmailApiFromCredential(env, c, ctx)))(
    credential,
    { orgId },
  );
  if (!api) return { ok: false, reason: "skipped" };
  return registerGmailWatch({
    api,
    topic,
    now: (args.now ?? (() => new Date()))(),
    record: async ({ topic: recorded, expiresAt }) => {
      await rpc.rpc("gmail_record_watch", {
        org_id: orgId,
        connection_id: connectionId,
        topic: recorded,
        expires_at: expiresAt.toISOString(),
      });
    },
  });
}

/**
 * Best-effort watch setup right after a Gmail connect. Never throws: the
 * connection is already stored and the poll and renewal cron cover failures.
 */
export async function setupWatchOnConnect(
  args: WatchArgs & { orgId: string; connectionId: string },
): Promise<WatchOutcome> {
  try {
    if (!gmailWatchEnabled(args.env)) return { ok: false, reason: "skipped" };
    const states = parseGmailWatchStates(
      await args.rpc.rpc("gmail_list_watch_state", {
        org_id: args.orgId,
        connection_id: args.connectionId,
      }),
    );
    if (states.length === 0 || states[0].environmentMode === "replay") {
      return { ok: false, reason: "skipped" };
    }
    return await registerWatchForConnection(args);
  } catch (err) {
    console.error("gmail watch setup failed", safeErrorLogFields(err));
    return { ok: false, reason: "provider_error" };
  }
}

/** Connections whose watch is missing, stale for the current topic, or near expiry. */
export async function listWatchesDue(args: WatchArgs): Promise<GmailWatchState[]> {
  const { rpc, env } = args;
  const topic = env.GMAIL_PUBSUB_TOPIC;
  if (!topic || !gmailWatchEnabled(env)) return [];
  const states = parseGmailWatchStates(await rpc.rpc("gmail_list_watch_state", {}));
  return selectWatchesDue(states, { topic, now: (args.now ?? (() => new Date()))() });
}
