import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { RpcClient } from "@/lib/db/messages";

export const ORG_A = "00000000-0000-4000-8000-000000000001";
export const ORG_B = "00000000-0000-4000-8000-000000000002";
export const ITEM_CARTON = "20000000-0000-4000-8000-000000000001";
export const LOCATION_MAIN = "10000000-0000-4000-8000-000000000001";

export const FIXED_NOW = new Date("2026-10-12T15:00:00Z");
export const now = () => FIXED_NOW;

export function pgClient(): Client {
  return new Client({
    connectionString:
      process.env.TEST_DATABASE_URL ??
      process.env.DATABASE_URL ??
      "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  });
}

/** pg-backed RpcClient: `select public.<fn>($1::jsonb) as r`. */
export function pgRpcClient(client: Client): RpcClient {
  return {
    async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
      const res = await client.query(`select public.${fn}($1::jsonb) as r`, [
        JSON.stringify(args),
      ]);
      return res.rows[0]?.r as T;
    },
  };
}

export const DATASET_ID = "30000000-0000-4000-8000-000000000001";

export interface InboxFixture {
  supplierId: string;
  contactId: string;
  itemTapeId: string;
  datasetId: string;
  po1042Id: string;
  po1042LineId: string;
  po1042ScheduleId: string;
  po1043Id: string;
  po1043LineId: string;
  po1043ScheduleId: string;
  po1044Id: string;
  po1044LineId: string;
  po1044ScheduleId: string;
  cleanup(): Promise<void>;
}

/**
 * Inserts the inbox business data for ORG_A: supplier BAY-CARTON with an
 * outreach-approved email contact, a second item TAPE-48MM (base_unit roll),
 * PO-1042 (4,000 cartons, schedule Oct 13 15:00Z confirmed), PO-1043 (1,000
 * rolls of TAPE-48MM, same schedule), PO-1044 (500 cartons — the ambiguity
 * twin of PO-1042). All ids are random per call; call cleanup() after.
 */
export async function seedInboxData(client: Client): Promise<InboxFixture> {
  const id = () => randomUUID();

  const upsert = async (
    sql: string,
    params: unknown[],
    selectSql: string,
    selectParams: unknown[],
  ): Promise<string> => {
    const res = await client.query(sql, params);
    if (res.rows[0]?.id) return res.rows[0].id;
    const sel = await client.query(selectSql, selectParams);
    return sel.rows[0].id;
  };

  // Active dataset so message-derived schedules are visible to F1's
  // projection engine; deterministic id makes reseeding idempotent.
  const datasetId = await upsert(
    `insert into public.datasets (id, org_id, source_type, source_as_of, content_hash, status)
     values ($1, $2, 'fixture', '2026-10-12T00:00:00Z', 'inbox-fixture', 'active')
     on conflict (id) do update set status = 'active'
     returning id`,
    [DATASET_ID, ORG_A],
    `select id from public.datasets where id = $1`,
    [DATASET_ID],
  );

  const itemTapeId = await upsert(
    `insert into public.items (id, org_id, sku, description, base_unit)
     values ($1, $2, 'TAPE-48MM', 'Packing tape 48mm', 'roll')
     on conflict (org_id, sku) do update set description = excluded.description
     returning id`,
    [id(), ORG_A],
    `select id from public.items where org_id = $1 and sku = 'TAPE-48MM'`,
    [ORG_A],
  );
  const supplierId = await upsert(
    `insert into public.suppliers (id, org_id, name, purchasing_status)
     values ($1, $2, 'BAY-CARTON', 'approved')
     on conflict (org_id, name) do update set purchasing_status = 'approved'
     returning id`,
    [id(), ORG_A],
    `select id from public.suppliers where org_id = $1 and name = 'BAY-CARTON'`,
    [ORG_A],
  );
  const contactId = await upsert(
    `insert into public.supplier_contacts
       (id, org_id, supplier_id, channel, normalized_address, display_name,
        permitted_channels, outreach_approved_at)
     values ($1, $2, $3, 'email', 'alyssa@baycarton.example.com', 'Alyssa Reed',
       array['email'], '2026-01-01T00:00:00Z')
     on conflict (org_id, channel, normalized_address)
     do update set supplier_id = excluded.supplier_id,
       outreach_approved_at = excluded.outreach_approved_at,
       permitted_channels = excluded.permitted_channels
     returning id`,
    [id(), ORG_A, supplierId],
    `select id from public.supplier_contacts
     where org_id = $1 and channel = 'email' and normalized_address = 'alyssa@baycarton.example.com'`,
    [ORG_A],
  );

  const po = async (
    externalId: string,
    itemId: string,
    qty: number,
  ): Promise<{ poId: string; lineId: string; scheduleId: string }> => {
    const poId = await upsert(
      `insert into public.purchase_orders (id, org_id, external_id, supplier_id, currency, status)
       values ($1, $2, $3, $4, 'USD', 'open')
       on conflict (org_id, external_id) do update set status = 'open'
       returning id`,
      [id(), ORG_A, externalId, supplierId],
      `select id from public.purchase_orders where org_id = $1 and external_id = $2`,
      [ORG_A, externalId],
    );
    const lineId = await upsert(
      `insert into public.purchase_order_lines
         (id, org_id, purchase_order_id, external_line_id, item_id,
          destination_location_id, ordered_qty, received_qty, cancelled_qty,
          unit_price_minor, original_due_at, dataset_id)
       values ($1, $2, $3, '1', $4, $5, $6, 0, 0, 100, '2026-10-13T15:00:00Z', $7)
       on conflict (org_id, purchase_order_id, external_line_id)
       do update set ordered_qty = excluded.ordered_qty, received_qty = 0,
         cancelled_qty = 0, dataset_id = excluded.dataset_id
       returning id`,
      [id(), ORG_A, poId, itemId, LOCATION_MAIN, qty, datasetId],
      `select id from public.purchase_order_lines
       where org_id = $1 and purchase_order_id = $2 and external_line_id = '1'`,
      [ORG_A, poId],
    );
    await client.query(
      `delete from public.commitment_events where org_id = $1 and po_line_id = $2`,
      [ORG_A, lineId],
    );
    await client.query(
      `delete from public.receipt_schedules where org_id = $1 and po_line_id = $2`,
      [ORG_A, lineId],
    );
    const scheduleId = id();
    await client.query(
      `insert into public.receipt_schedules
         (id, org_id, po_line_id, quantity_remaining, earliest_at, latest_at,
          promise_state, dataset_id, external_id)
       values ($1, $2, $3, $4, '2026-10-13T15:00:00Z', '2026-10-13T15:00:00Z',
         'confirmed', $5, $6)`,
      [scheduleId, ORG_A, lineId, qty, datasetId, `sched-${externalId}-1`],
    );
    return { poId, lineId, scheduleId };
  };

  const p1042 = await po("PO-1042", ITEM_CARTON, 4000);
  const p1043 = await po("PO-1043", itemTapeId, 1000);
  const p1044 = await po("PO-1044", ITEM_CARTON, 500);

  const po1042Id = p1042.poId;
  const po1042LineId = p1042.lineId;
  const po1042ScheduleId = p1042.scheduleId;
  const po1043Id = p1043.poId;
  const po1043LineId = p1043.lineId;
  const po1043ScheduleId = p1043.scheduleId;
  const po1044Id = p1044.poId;
  const po1044LineId = p1044.lineId;
  const po1044ScheduleId = p1044.scheduleId;

  const cleanup = async () => {
    const lineIds = [po1042LineId, po1043LineId, po1044LineId];
    await client.query(
      `delete from public.commitment_events where org_id = $1 and po_line_id = any($2::uuid[])`,
      [ORG_A, lineIds],
    );
    await client.query(
      `delete from public.receipt_schedules where org_id = $1 and po_line_id = any($2::uuid[])`,
      [ORG_A, lineIds],
    );
    await client.query(
      `delete from public.purchase_order_lines where id = any($1::uuid[])`,
      [[po1042LineId, po1043LineId, po1044LineId]],
    );
    await client.query(
      `delete from public.purchase_orders where id = any($1::uuid[])`,
      [[po1042Id, po1043Id, po1044Id]],
    );
    await client.query(`delete from public.supplier_contacts where id = $1`, [
      contactId,
    ]);
    await client.query(`delete from public.suppliers where id = $1`, [supplierId]);
    await client.query(`delete from public.items where id = $1`, [itemTapeId]);
    await client.query(`delete from public.datasets where id = $1`, [datasetId]);
  };

  return {
    supplierId,
    contactId,
    itemTapeId,
    datasetId,
    po1042Id,
    po1042LineId,
    po1042ScheduleId,
    po1043Id,
    po1043LineId,
    po1043ScheduleId,
    po1044Id,
    po1044LineId,
    po1044ScheduleId,
    cleanup,
  };
}

/** Restore the three fixture PO lines to one original confirmed schedule each. */
export async function resetPoSchedules(client: Client, fixture: InboxFixture) {
  await client.query("set session_replication_role = replica");
  const lineIds = [fixture.po1042LineId, fixture.po1043LineId, fixture.po1044LineId];
  const qtys = [4000, 1000, 500];
  await client.query(
    `delete from public.commitment_events where org_id = $1 and po_line_id = any($2::uuid[])`,
    [ORG_A, lineIds],
  );
  await client.query(
    `delete from public.receipt_schedules where org_id = $1 and po_line_id = any($2::uuid[])`,
    [ORG_A, lineIds],
  );
  const externalIds = ["sched-PO-1042-1", "sched-PO-1043-1", "sched-PO-1044-1"];
  for (let i = 0; i < lineIds.length; i++) {
    await client.query(
      `insert into public.receipt_schedules
         (org_id, po_line_id, quantity_remaining, earliest_at, latest_at,
          promise_state, dataset_id, external_id)
       values ($1, $2, $3, '2026-10-13T15:00:00Z', '2026-10-13T15:00:00Z',
         'confirmed', $4, $5)`,
      [ORG_A, lineIds[i], qtys[i], fixture.datasetId, externalIds[i]],
    );
  }
  await client.query("set session_replication_role = default");
}

export async function cleanupMessages(client: Client, orgId: string) {
  // Delete messages and dependents created during a test (org-scoped).
  // Append-only triggers block deletes; bypass them for test cleanup.
  await client.query("set session_replication_role = replica");
  await client.query(
    `delete from private.source_message_content where org_id = $1`,
    [orgId],
  );
  await client.query(`delete from public.message_match_reviews where org_id = $1`, [
    orgId,
  ]);
  await client.query(`delete from public.message_extractions where org_id = $1`, [
    orgId,
  ]);
  await client.query(
    `delete from public.case_evidence where org_id = $1 and purpose in ('delay_notice','unmatched_delay_notice')`,
    [orgId],
  );
  await client.query(
    `delete from public.case_order_lines where org_id = $1 and triggering_message_id is not null`,
    [orgId],
  );
  await client.query(
    `delete from public.evidence where org_id = $1 and source_type in ('email','email_attachment')`,
    [orgId],
  );
  await client.query(
    `delete from public.event_outbox where org_id = $1 and event_type in ('supplier.message.received','case.assessment.requested')`,
    [orgId],
  );
  await client.query(`delete from public.inbox_request_keys where org_id = $1`, [
    orgId,
  ]);
  await client.query(`delete from public.commitment_events where org_id = $1`, [
    orgId,
  ]);
  await client.query(`delete from public.audit_events where org_id = $1`, [orgId]);
  await client.query(`delete from public.cases where org_id = $1`, [orgId]);
  await client.query(`delete from public.source_messages where org_id = $1`, [
    orgId,
  ]);
  await client.query(
    `delete from public.connections where org_id = $1 and provider in ('replay_inbox','manual_paste','gmail')`,
    [orgId],
  );
  await client.query("set session_replication_role = default");
}
