import type { Clock, Rpc } from "@/lib/actions/rpc";

/** Event names F5 adds on top of the shared map (see PR contract change request). */
export const f5EventNames = ["action.prepared"] as const;

export interface OutboxRow {
  event_id: string;
  org_id: string;
  aggregate_id: string;
  correlation_id: string;
  causation_id: string | null;
  event_type: string;
  schema_version: number;
  payload: Record<string, unknown>;
  created_at: string;
  attempts: number;
}

export interface PublishedEvent {
  /** Inngest deduplicates sends with the same id, so redelivered outbox rows are harmless. */
  id: string;
  name: string;
  data: Record<string, unknown> & { org_id: string; event_id: string; correlation_id: string };
}

export type EventSender = (events: PublishedEvent[]) => Promise<unknown>;

export function toPublishedEvent(row: OutboxRow): PublishedEvent {
  return {
    id: row.event_id,
    name: row.event_type,
    data: { ...row.payload, org_id: row.org_id, event_id: row.event_id, correlation_id: row.correlation_id },
  };
}

/**
 * Publishes committed outbox rows. Rows are only visible after the writing transaction commits;
 * they are marked published only after the sender succeeds, so a crash means redelivery, never loss.
 */
export async function drainOutbox(
  deps: { rpc: Rpc; clock: Clock; send: EventSender },
  limit = 100,
): Promise<{ published: number }> {
  const rows = ((await deps.rpc("outbox_claim_batch", { p_limit: limit, p_event_ids: null })) ?? []) as OutboxRow[];
  if (rows.length === 0) return { published: 0 };
  await deps.send(rows.map(toPublishedEvent));
  await deps.rpc("outbox_mark_published", {
    p_event_ids: rows.map((r) => r.event_id),
    p_now: deps.clock.now().toISOString(),
  });
  return { published: rows.length };
}

/** Best-effort publish right after a request commits; the every-minute cron catches anything missed. */
export async function publishAfterCommit(deps: { rpc: Rpc; clock: Clock; send: EventSender }): Promise<void> {
  try {
    await drainOutbox(deps);
  } catch {
    // Left unpublished; the cron drain retries.
  }
}

/** Consumer-side dedupe by event_id: true the first time a consumer sees an event. */
export async function consumeOnce(rpc: Rpc, consumer: string, orgId: string, eventId: string): Promise<boolean> {
  return (await rpc("consumer_dedupe", { p_org_id: orgId, p_consumer: consumer, p_event_id: eventId })) === true;
}
