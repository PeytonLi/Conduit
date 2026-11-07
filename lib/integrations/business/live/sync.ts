import { createHash } from "node:crypto";
import type { Clock, Rpc } from "@/lib/actions/rpc";
import { recordReceipt } from "@/lib/actions/receipts";
import { erpReceiptSchema, erpSnapshotSchema } from "./schemas";
import type { ErpConnection } from "./resolve";
import type { ErpClient, ErpSnapshot } from "./types";

export interface SyncDeps {
  rpc: Rpc;
  clock: Clock;
}

export type SnapshotSyncResult =
  | { outcome: "activated"; datasetId: string; supersededDatasetId: string | null }
  | { outcome: "noop_same_content"; datasetId: string }
  | { outcome: "not_connected" };

const byKey = <T>(rows: T[], key: (row: T) => string) =>
  [...rows].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

/** Validates a provider snapshot and puts it in a stable order; duplicate stock rows are summed. */
export function normalizeSnapshot(raw: unknown): ErpSnapshot {
  const s = erpSnapshotSchema.parse(raw);
  const stock = new Map<string, { item_external_id: string; location_external_id: string; on_hand_qty: number; unusable_qty: number }>();
  for (const row of s.stock) {
    const k = `${row.item_external_id}\u0000${row.location_external_id}`;
    const prev = stock.get(k);
    stock.set(k, {
      item_external_id: row.item_external_id,
      location_external_id: row.location_external_id,
      on_hand_qty: (prev?.on_hand_qty ?? 0) + row.on_hand_qty,
      unusable_qty: (prev?.unusable_qty ?? 0) + (row.unusable_qty ?? 0),
    });
  }
  return {
    as_of: s.as_of,
    locations: byKey(s.locations, (r) => r.external_id),
    items: byKey(s.items, (r) => r.external_id),
    suppliers: byKey(s.suppliers, (r) => r.external_id),
    purchase_orders: byKey(s.purchase_orders, (r) => r.external_id).map((po) => ({
      ...po,
      lines: byKey(po.lines, (l) => l.external_line_id),
    })),
    stock: byKey([...stock.values()], (r) => `${r.item_external_id}\u0000${r.location_external_id}`),
    demand: byKey(s.demand, (r) => r.external_id),
  };
}

/** Hash of the business content; as_of is excluded so an unchanged system does not churn datasets. */
export function snapshotContentHash(snapshot: ErpSnapshot): string {
  const { as_of: _asOf, ...content } = snapshot;
  void _asOf;
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

export async function syncSnapshot(
  deps: SyncDeps,
  input: { orgId: string; connection: ErpConnection; client: ErpClient },
): Promise<SnapshotSyncResult> {
  const snapshot = normalizeSnapshot(await input.client.readSnapshot());
  const result = (await deps.rpc("erp_activate_snapshot", {
    p: {
      org_id: input.orgId,
      connection_id: input.connection.connectionId,
      content_hash: snapshotContentHash(snapshot),
      snapshot,
    },
  })) as { outcome: string; dataset_id?: string; superseded_dataset_id?: string | null };
  if (result.outcome === "activated" && result.dataset_id) {
    return { outcome: "activated", datasetId: result.dataset_id, supersededDatasetId: result.superseded_dataset_id ?? null };
  }
  if (result.outcome === "noop_same_content" && result.dataset_id) {
    return { outcome: "noop_same_content", datasetId: result.dataset_id };
  }
  return { outcome: "not_connected" };
}

export interface ReceiptSyncResult {
  recorded: number;
  duplicates: number;
  unmatched: number;
  failed: number;
  cursor: string;
}

/** Ingests provider receipts through record_receipt. Ids are prefixed with the provider so they stay unique. */
export async function syncReceipts(
  deps: SyncDeps,
  input: { orgId: string; connection: ErpConnection; client: ErpClient; since: string | null },
): Promise<ReceiptSyncResult> {
  const startedAt = deps.clock.now().toISOString();
  const since = input.since ?? new Date(Date.parse(startedAt) - 30 * 86_400_000).toISOString();
  const receipts = (await input.client.listReceipts(since)).map((r) => erpReceiptSchema.parse(r));
  const prefix = `${input.connection.provider}:`;
  const lineIds = (await deps.rpc("erp_resolve_po_lines", {
    p: {
      org_id: input.orgId,
      refs: receipts.map((r) => ({ po_external_id: r.po_external_id, line_external_id: r.line_external_id })),
    },
  })) as Record<string, string>;
  const nextCursor = new Date(Date.parse(startedAt) - 5 * 60_000).toISOString();
  const result: ReceiptSyncResult = { recorded: 0, duplicates: 0, unmatched: 0, failed: 0, cursor: nextCursor };
  const ordered = [...receipts].sort((a, b) =>
    a.kind === b.kind ? a.received_at.localeCompare(b.received_at) : a.kind === "received" ? -1 : 1,
  );
  for (const r of ordered) {
    const poLineId = lineIds[`${r.po_external_id}\u001f${r.line_external_id}`];
    if (!poLineId) {
      result.unmatched += 1;
      continue;
    }
    const outcome = await recordReceipt(deps, {
      orgId: input.orgId,
      actorId: `business_sync:${input.connection.provider}`,
      receipt: {
        po_line_id: poLineId,
        external_receipt_id: prefix + r.external_receipt_id,
        quantity: r.quantity,
        received_at: r.received_at,
        kind: r.kind,
        reverses_external_id: r.reverses_external_id ? prefix + r.reverses_external_id : undefined,
      },
    });
    if (!outcome.ok) result.failed += 1;
    else if (outcome.duplicate) result.duplicates += 1;
    else result.recorded += 1;
  }
  if (result.failed > 0) result.cursor = since;
  return result;
}
