import type { Clock, Rpc } from "@/lib/actions/rpc";
import { ensureErpProviders } from "./providers";
import { resolveErpClient, type ResolveErpDeps } from "./resolve";
import { syncReceipts, syncSnapshot, type ReceiptSyncResult, type SnapshotSyncResult } from "./sync";

export type ConnectionSyncReport =
  | { status: "synced"; snapshot: SnapshotSyncResult; receipts: ReceiptSyncResult }
  | { status: "skipped"; reason: string }
  | { status: "failed"; errorCode: string };

/** Pulls one connection's snapshot and receipts, and records health on the connection. */
export async function runConnectionSync(
  deps: { rpc: Rpc; clock: Clock; encryptionKey: ResolveErpDeps["encryptionKey"]; fetch?: typeof fetch },
  input: { orgId: string; connectionId: string },
): Promise<ConnectionSyncReport> {
  ensureErpProviders();
  const resolved = await resolveErpClient(
    { rpc: deps.rpc, encryptionKey: deps.encryptionKey, fetch: deps.fetch, now: () => deps.clock.now() },
    input.orgId,
    input.connectionId,
  );
  const record = (p: { error_code: string | null; sync_cursor?: string }) =>
    deps.rpc("erp_record_sync", {
      p: { org_id: input.orgId, connection_id: input.connectionId, now: deps.clock.now().toISOString(), ...p },
    });
  if (resolved.status === "not_connected") return { status: "skipped", reason: resolved.reason };
  if (resolved.status !== "ready") {
    await record({ error_code: resolved.status });
    return { status: "skipped", reason: resolved.reason };
  }
  try {
    const snapshot = await syncSnapshot(deps, { orgId: input.orgId, connection: resolved.connection, client: resolved.client });
    const receipts = await syncReceipts(deps, {
      orgId: input.orgId,
      connection: resolved.connection,
      client: resolved.client,
      since: resolved.connection.syncCursor,
    });
    await record({ error_code: receipts.failed > 0 ? "receipt_sync_partial" : null, sync_cursor: receipts.cursor });
    return { status: "synced", snapshot, receipts };
  } catch {
    await record({ error_code: "sync_failed" });
    return { status: "failed", errorCode: "sync_failed" };
  }
}
