import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { Clock, Rpc } from "@/lib/actions/rpc";
import { asReplayAdapter, registerReplayAdapter, type ReplayAdapter } from "@/lib/actions/replay";
import type { ActionKind, DispatchResult, ReconcileResult } from "@/lib/actions/types";
import { registerF5Adapters } from "@/lib/actions/adapters/index";
import type { DispatcherDeps } from "@/lib/actions/dispatcher";

export const FIXTURE_NOW = "2026-10-12T15:00:00.000Z";

export function connect(): Client {
  return new Client({
    connectionString:
      process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  });
}

export class FakeClock implements Clock {
  private t: number;
  constructor(iso = FIXTURE_NOW) {
    this.t = Date.parse(iso);
  }
  now() {
    return new Date(this.t);
  }
  advance(seconds: number) {
    this.t += seconds * 1000;
  }
  set(iso: string) {
    this.t = Date.parse(iso);
  }
}

const isPgArray = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Calls a ledger function with named arguments, like supabase.rpc does. */
export function pgRpc(client: Client): Rpc {
  return async (fn, args) => {
    const names = Object.keys(args);
    const values = names.map((n) => {
      const v = args[n];
      if (v !== null && typeof v === "object" && !isPgArray(v)) return JSON.stringify(v);
      return v;
    });
    const sql = `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(", ")}) as r`;
    const { rows } = await client.query(sql, values);
    return rows[0].r;
  };
}

export interface Counting {
  dispatches: number;
  finds: number;
  adapter: ReplayAdapter;
  dispatchImpl: () => Promise<DispatchResult>;
  findImpl: () => Promise<ReconcileResult>;
}

/** Counts external requests so tests can prove exactly-once dispatch under retries and crashes. */
export function countingAdapter(kind: ActionKind): Counting {
  const state: Counting = {
    dispatches: 0,
    finds: 0,
    dispatchImpl: async () => ({ outcome: "submitted", providerRef: "fake-ref", safeSummary: "fake sent" }),
    findImpl: async () => ({ outcome: "confirmed", providerRef: "fake-ref", safeSummary: "fake delivered" }),
    adapter: undefined as unknown as ReplayAdapter,
  };
  state.adapter = asReplayAdapter({
    kind,
    dispatch: async () => {
      state.dispatches += 1;
      return state.dispatchImpl();
    },
    findResult: async () => {
      state.finds += 1;
      return state.findImpl();
    },
  });
  return state;
}

export interface Harbor {
  orgId: string;
  ownerId: string;
  operatorId: string;
  viewerId: string;
  caseId: string;
  itemId: string;
  locationId: string;
  supplierId: string;
  contactId: string;
  phoneContactId: string;
  datasetId: string;
  poLineId: string;
  scheduleId: string;
  assessmentId: string;
  evidenceId: string;
  demandIds: string[];
}

export function deps(client: Client, clock: Clock, adapters: ReplayAdapter[] = []): DispatcherDeps {
  const d = { rpc: pgRpc(client), clock };
  registerF5Adapters(d);
  for (const a of adapters) registerReplayAdapter(a);
  return d;
}

async function insert(client: Client, table: string, row: Record<string, unknown>): Promise<string> {
  const id = (row.id as string) ?? randomUUID();
  const full = { id, ...row };
  const cols = Object.keys(full);
  await client.query(
    `insert into public.${table} (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
    cols.map((c) => {
      const v = full[c as keyof typeof full];
      return v !== null && typeof v === "object" && !isPgArray(v) ? JSON.stringify(v) : v;
    }),
  );
  return id;
}

async function user(client: Client, label: string): Promise<string> {
  const id = randomUUID();
  await client.query(
    `insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
       raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '', now(),
       '{"provider":"email","providers":["email"]}', '{}', now(), now())`,
    [id, `${label}-${id}@harbor.example`],
  );
  return id;
}

export const enabledPolicy = { outreach: { email_enabled: true, call_enabled: true } };

/** Harbor Pack: 600 on hand, 4,000 due Tuesday delayed to Friday, 400/day demand Tue-Thu. */
export async function seedHarbor(client: Client, opts: { mode?: "replay" | "sandbox" | "live"; policy?: unknown } = {}): Promise<Harbor> {
  const orgId = await insert(client, "organizations", {
    name: `Harbor Pack ${randomUUID()}`,
    timezone: "America/Chicago",
    currency: "USD",
    environment_mode: opts.mode ?? "replay",
  });
  const ownerId = await user(client, "owner");
  const operatorId = await user(client, "operator");
  const viewerId = await user(client, "viewer");
  for (const [uid, role] of [
    [ownerId, "owner"],
    [operatorId, "operator"],
    [viewerId, "viewer"],
  ]) {
    await insert(client, "memberships", { org_id: orgId, auth_user_id: uid, role });
  }
  const rpc = pgRpc(client);
  await rpc("policy_create_version", {
    p_org_id: orgId,
    p_actor_user_id: ownerId,
    p_expected_version: 0,
    p_settings: opts.policy ?? enabledPolicy,
    p_reason: "harness",
    p_now: FIXTURE_NOW,
  });
  const locationId = await insert(client, "locations", { org_id: orgId, name: "Main DC", timezone: "America/Chicago" });
  const itemId = await insert(client, "items", { org_id: orgId, sku: "CTN-12", description: "12in carton", base_unit: "carton" });
  const supplierId = await insert(client, "suppliers", { org_id: orgId, name: "Acme Corrugated", purchasing_status: "approved" });
  const contactId = await insert(client, "supplier_contacts", {
    org_id: orgId,
    supplier_id: supplierId,
    channel: "email",
    normalized_address: `orders-${randomUUID()}@acme.example`,
    timezone: "America/Chicago",
    permitted_channels: ["email"],
    outreach_approved_at: "2026-10-01T00:00:00Z",
    outreach_approved_by: ownerId,
  });
  const phoneContactId = await insert(client, "supplier_contacts", {
    org_id: orgId,
    supplier_id: supplierId,
    channel: "phone",
    normalized_address: `+1555${Math.floor(Math.random() * 1e7)}`,
    timezone: "America/Chicago",
    permitted_channels: ["phone"],
    outreach_approved_at: "2026-10-01T00:00:00Z",
    outreach_approved_by: ownerId,
  });
  const datasetId = await insert(client, "datasets", {
    org_id: orgId,
    source_type: "fixture",
    source_as_of: FIXTURE_NOW,
    content_hash: "fixture",
    status: "active",
  });
  await insert(client, "inventory_snapshots", {
    org_id: orgId,
    dataset_id: datasetId,
    item_id: itemId,
    location_id: locationId,
    physical_qty: 600,
    source_as_of: FIXTURE_NOW,
  });
  const demandIds: string[] = [];
  for (const day of ["2026-10-13", "2026-10-14", "2026-10-15"]) {
    demandIds.push(
      await insert(client, "demand_requirements", {
        org_id: orgId,
        dataset_id: datasetId,
        item_id: itemId,
        location_id: locationId,
        remaining_qty: 400,
        required_at: `${day}T16:00:00Z`,
        certainty: "confirmed",
        source_as_of: FIXTURE_NOW,
      }),
    );
  }
  const poId = await insert(client, "purchase_orders", {
    org_id: orgId,
    external_id: `PO-1042-${randomUUID()}`,
    supplier_id: supplierId,
    currency: "USD",
  });
  const poLineId = await insert(client, "purchase_order_lines", {
    org_id: orgId,
    purchase_order_id: poId,
    external_line_id: "1",
    item_id: itemId,
    destination_location_id: locationId,
    ordered_qty: 4000,
    unit_price_minor: 100,
    original_due_at: "2026-10-13T15:00:00Z",
  });
  const scheduleId = await insert(client, "receipt_schedules", {
    org_id: orgId,
    po_line_id: poLineId,
    quantity_remaining: 4000,
    earliest_at: "2026-10-16T15:00:00Z",
    latest_at: "2026-10-16T22:00:00Z",
    promise_state: "estimated",
  });
  const caseId = await insert(client, "cases", { org_id: orgId, item_id: itemId, location_id: locationId, phase: "recovering" });
  const assessmentId = await insert(client, "assessments", {
    org_id: orgId,
    case_id: caseId,
    version: 1,
    input_fingerprint: "assessment-fp",
    quality: "sufficient",
  });
  const evidenceId = await insert(client, "evidence", { org_id: orgId, source_type: "email", content_hash: "split-confirmation" });
  return {
    orgId,
    ownerId,
    operatorId,
    viewerId,
    caseId,
    itemId,
    locationId,
    supplierId,
    contactId,
    phoneContactId,
    datasetId,
    poLineId,
    scheduleId,
    assessmentId,
    evidenceId,
    demandIds,
  };
}

/** The canonical split: 600 Wednesday morning, 3,400 Friday. */
export function splitStep(h: Harbor, mode: "demo_ledger" | "manual" = "demo_ledger") {
  return {
    step_id: "split",
    kind: "amend_delivery_schedule",
    quantity: 600,
    unit: "carton",
    depends_on_step_ids: [],
    evidence_ids: [h.evidenceId],
    execution_mode: mode,
    payload: {
      po_line_id: h.poLineId,
      receipt_schedule_id: h.scheduleId,
      supplier_confirmation_evidence_id: h.evidenceId,
      added_cost_minor: "7500",
      demand_ids: h.demandIds.slice(1),
      schedules: [
        { quantity: 600, earliest_at: "2026-10-14T13:00:00Z", latest_at: "2026-10-14T15:00:00Z" },
        { quantity: 3400, earliest_at: "2026-10-16T15:00:00Z", latest_at: "2026-10-16T22:00:00Z" },
      ],
    },
  };
}

export async function createPlan(d: DispatcherDeps, h: Harbor, steps: unknown[] = [splitStep(h)], key = randomUUID()) {
  return (await d.rpc("plan_create", {
    p_org_id: h.orgId,
    p_case_id: h.caseId,
    p_actor_user_id: h.operatorId,
    p_assessment_id: h.assessmentId,
    p_steps: steps,
    p_idempotency_key: key,
    p_now: d.clock.now().toISOString(),
  })) as { ok: boolean; code?: string; plan_id: string; version: number; status: string; input_fingerprint: string; gross_commitment_minor: string; missing_fields: string[] };
}

export async function planRow(client: Client, planId: string) {
  return (await client.query("select * from public.recovery_plans where id = $1", [planId])).rows[0];
}

export async function approve(
  d: DispatcherDeps,
  client: Client,
  h: Harbor,
  planId: string,
  overrides: Partial<{ user: string; ceiling: string; fingerprint: string; key: string; expected: number }> = {},
) {
  const plan = await planRow(client, planId);
  return (await d.rpc("approve_plan", {
    p_org_id: h.orgId,
    p_plan_id: planId,
    p_actor_user_id: overrides.user ?? h.ownerId,
    p_plan_version: plan.version,
    p_input_fingerprint: overrides.fingerprint ?? plan.input_fingerprint,
    p_approved_ceiling_minor: overrides.ceiling ?? "7500",
    p_expected_version: overrides.expected ?? plan.row_version,
    p_idempotency_key: overrides.key ?? randomUUID(),
    p_now: d.clock.now().toISOString(),
  })) as { ok: boolean; code?: string; approval_id: string; expires_at: string; replayed?: boolean };
}
