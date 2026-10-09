import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { RpcClient } from "@/lib/db/messages";

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

export interface InboxOrg {
  orgId: string;
  locationId: string;
}

/**
 * Every test file gets its own organization so suites can run in parallel
 * against one database without touching the shared Phase 1 seed org.
 */
export async function createInboxOrg(
  client: Client,
  name = `inbox-${randomUUID().slice(0, 8)}`,
): Promise<InboxOrg> {
  const orgId = randomUUID();
  const locationId = randomUUID();
  await client.query(
    `insert into public.organizations (id, name, timezone, currency)
     values ($1, $2, 'America/Los_Angeles', 'USD')`,
    [orgId, name],
  );
  await client.query(
    `insert into public.locations (id, org_id, name, timezone)
     values ($1, $2, 'Main Warehouse', 'America/Los_Angeles')`,
    [locationId, orgId],
  );
  return { orgId, locationId };
}

export interface InboxFixture extends InboxOrg {
  datasetId: string;
  itemCartonId: string;
  itemTapeId: string;
  supplierId: string;
  contactId: string;
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
 * Seeds a dedicated org with: an active dataset, item CARTON-302015, item
 * TAPE-48MM (base_unit roll), supplier BAY-CARTON with an outreach-approved
 * email contact, PO-1042 (4,000 cartons, schedule Oct 13 15:00Z confirmed),
 * PO-1043 (1,000 rolls, same schedule), PO-1044 (500 cartons — the ambiguity
 * twin of PO-1042). Call cleanup() after.
 */
export async function seedInboxData(client: Client): Promise<InboxFixture> {
  const id = () => randomUUID();
  const { orgId, locationId } = await createInboxOrg(client);

  const datasetId = id();
  await client.query(
    `insert into public.datasets (id, org_id, source_type, source_as_of, content_hash, status)
     values ($1, $2, 'fixture', '2026-10-12T00:00:00Z', 'inbox-fixture', 'active')`,
    [datasetId, orgId],
  );

  const itemCartonId = id();
  await client.query(
    `insert into public.items (id, org_id, sku, description, base_unit)
     values ($1, $2, 'CARTON-302015', 'Shipping carton 30x20x15', 'carton')`,
    [itemCartonId, orgId],
  );
  const itemTapeId = id();
  await client.query(
    `insert into public.items (id, org_id, sku, description, base_unit)
     values ($1, $2, 'TAPE-48MM', 'Packing tape 48mm', 'roll')`,
    [itemTapeId, orgId],
  );

  const supplierId = id();
  await client.query(
    `insert into public.suppliers (id, org_id, name, purchasing_status)
     values ($1, $2, 'BAY-CARTON', 'approved')`,
    [supplierId, orgId],
  );
  const contactId = id();
  await client.query(
    `insert into public.supplier_contacts
       (id, org_id, supplier_id, channel, normalized_address, display_name,
        permitted_channels, outreach_approved_at)
     values ($1, $2, $3, 'email', 'alyssa@baycarton.example.com', 'Alyssa Reed',
       array['email'], '2026-01-01T00:00:00Z')`,
    [contactId, orgId, supplierId],
  );

  const po = async (
    externalId: string,
    itemId: string,
    qty: number,
  ): Promise<{ poId: string; lineId: string; scheduleId: string }> => {
    const poId = id();
    await client.query(
      `insert into public.purchase_orders (id, org_id, external_id, supplier_id, currency, status)
       values ($1, $2, $3, $4, 'USD', 'open')`,
      [poId, orgId, externalId, supplierId],
    );
    const lineId = id();
    await client.query(
      `insert into public.purchase_order_lines
         (id, org_id, purchase_order_id, external_line_id, item_id,
          destination_location_id, ordered_qty, received_qty, cancelled_qty,
          unit_price_minor, original_due_at, dataset_id)
       values ($1, $2, $3, '1', $4, $5, $6, 0, 0, 100, '2026-10-13T15:00:00Z', $7)`,
      [lineId, orgId, poId, itemId, locationId, qty, datasetId],
    );
    const scheduleId = id();
    await client.query(
      `insert into public.receipt_schedules
         (id, org_id, po_line_id, quantity_remaining, earliest_at, latest_at,
          promise_state, dataset_id, external_id)
       values ($1, $2, $3, $4, '2026-10-13T15:00:00Z', '2026-10-13T15:00:00Z',
         'confirmed', $5, $6)`,
      [scheduleId, orgId, lineId, qty, datasetId, `sched-${externalId}-1`],
    );
    return { poId, lineId, scheduleId };
  };

  const p1042 = await po("PO-1042", itemCartonId, 4000);
  const p1043 = await po("PO-1043", itemTapeId, 1000);
  const p1044 = await po("PO-1044", itemCartonId, 500);

  const cleanup = async () => {
    // Deleting the org cascades to everything seeded above.
    await client.query("set session_replication_role = replica");
    await client.query(`delete from public.organizations where id = $1`, [
      orgId,
    ]);
    await client.query("set session_replication_role = default");
  };

  return {
    orgId,
    locationId,
    datasetId,
    itemCartonId,
    itemTapeId,
    supplierId,
    contactId,
    po1042Id: p1042.poId,
    po1042LineId: p1042.lineId,
    po1042ScheduleId: p1042.scheduleId,
    po1043Id: p1043.poId,
    po1043LineId: p1043.lineId,
    po1043ScheduleId: p1043.scheduleId,
    po1044Id: p1044.poId,
    po1044LineId: p1044.lineId,
    po1044ScheduleId: p1044.scheduleId,
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
    [fixture.orgId, lineIds],
  );
  await client.query(
    `delete from public.receipt_schedules where org_id = $1 and po_line_id = any($2::uuid[])`,
    [fixture.orgId, lineIds],
  );
  const externalIds = ["sched-PO-1042-1", "sched-PO-1043-1", "sched-PO-1044-1"];
  for (let i = 0; i < lineIds.length; i++) {
    await client.query(
      `insert into public.receipt_schedules
         (org_id, po_line_id, quantity_remaining, earliest_at, latest_at,
          promise_state, dataset_id, external_id)
       values ($1, $2, $3, '2026-10-13T15:00:00Z', '2026-10-13T15:00:00Z',
         'confirmed', $4, $5)`,
      [fixture.orgId, lineIds[i], qtys[i], fixture.datasetId, externalIds[i]],
    );
  }
  await client.query("set session_replication_role = default");
}

/** Deletes messages and dependents for one org only. */
export async function cleanupMessages(client: Client, orgId: string) {
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
