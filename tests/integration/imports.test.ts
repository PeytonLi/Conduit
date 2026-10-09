import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { buildProjectionInput, type ProjectionFacts } from "@/lib/domain/assessment-input";
import { validateImport, type NormalizedImport } from "@/lib/domain/import-validate";
import { projectInventory } from "@/lib/domain/inventory";

const fixtureClock = "2026-10-12T15:00:00Z";
const metadata = {
  schema_version: 1 as const,
  source_as_of: fixtureClock,
  timezone: "America/Los_Angeles",
  currency: "USD",
};
const fileNames = [
  "suppliers.csv",
  "items.csv",
  "purchase_orders.csv",
  "purchase_order_lines.csv",
  "receipt_schedules.csv",
  "inventory.csv",
  "demand.csv",
];
const baseFiles = Object.fromEntries(fileNames.map((fileName) => [
  fileName,
  readFileSync(join(process.cwd(), "tests/fixtures/harbor-pack", fileName), "utf8"),
]));
const expected = JSON.parse(
  readFileSync(join(process.cwd(), "tests/fixtures/harbor-pack/expected.json"), "utf8"),
) as {
  first_shortage_at: string;
  bridge_quantity: number;
  requirements: { by: string; cumulative_quantity: number }[];
};
const orgId = randomUUID();
const otherOrgId = randomUUID();
const ownerId = randomUUID();
const operatorId = randomUUID();
const otherUserId = randomUUID();
const locationId = randomUUID();

const client = new Client({
  connectionString:
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
});

type RpcResult = Record<string, unknown> & { outcome: string };

function jsonb<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

async function insertAuthUser(id: string) {
  await client.query(
    `insert into auth.users
      (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
       confirmation_token,
       raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated',
       'authenticated', $2, '', now(), '', '{"provider":"email","providers":["email"]}',
       '{}', now(), now())`,
    [id, `${id}@imports.test`],
  );
  await client.query(
    `update auth.users set recovery_token = '', email_change_token_new = '',
      email_change = '', phone_change = '', phone_change_token = '',
      email_change_token_current = '', reauthentication_token = '' where id = $1`,
    [id],
  );
}

async function stageImport(
  files: Record<string, string> = baseFiles,
  idempotencyKey = `stage-${randomUUID()}`,
  options: {
    payload?: NormalizedImport;
    contentHash?: string;
    valid?: boolean;
  } = {},
): Promise<RpcResult> {
  const validation = validateImport({
    files,
    metadata,
    orgCurrency: "USD",
    knownLocations: [{
      id: locationId,
      externalId: "MAIN-WAREHOUSE",
      timezone: "America/Los_Angeles",
    }],
    now: fixtureClock,
  });
  const payload = options.payload === undefined ? validation.payload : options.payload;
  const contentHash = options.contentHash ?? validation.contentHash;
  const validationSummary = {
    errors: validation.errors,
    warnings: validation.warnings,
    counts: validation.counts,
  };
  const result = await client.query<{ result: unknown }>(
    `select public.stage_import(
       $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::timestamptz,
       $7::boolean, $8::jsonb, $9::jsonb
     ) as result`,
    [
      orgId,
      ownerId,
      idempotencyKey,
      createHash("sha256").update(contentHash).digest("hex"),
      contentHash,
      payload?.metadata.source_as_of ?? metadata.source_as_of,
      options.valid ?? validation.ok,
      JSON.stringify(validationSummary),
      payload === null ? null : JSON.stringify(payload),
    ],
  );
  return jsonb<RpcResult>(result.rows[0].result);
}

async function activateImport(args: {
  importId: string;
  expectedVersion?: number;
  actorId?: string;
  role?: "owner" | "operator";
  contactPermissionsConfirmed?: boolean;
  idempotencyKey?: string;
}): Promise<RpcResult> {
  const result = await client.query<{ result: unknown }>(
    `select public.activate_import(
       $1::uuid, $2::uuid, $3::integer, $4::uuid,
       $5::public.membership_role, $6::boolean, $7::text
     ) as result`,
    [
      orgId,
      args.importId,
      args.expectedVersion ?? 1,
      args.actorId ?? ownerId,
      args.role ?? "owner",
      args.contactPermissionsConfirmed ?? false,
      args.idempotencyKey ?? `activate-${randomUUID()}`,
    ],
  );
  return jsonb<RpcResult>(result.rows[0].result);
}

async function countRows(sql: string, values: unknown[] = []): Promise<number> {
  const result = await client.query<{ count: string }>(sql, values);
  return Number(result.rows[0].count);
}

describe("CSV import persistence and activation", () => {
  beforeAll(async () => {
    await client.connect();
    await insertAuthUser(ownerId);
    await insertAuthUser(operatorId);
    await insertAuthUser(otherUserId);
    await client.query(
      `insert into public.organizations (id, name, timezone, currency)
       values ($1, 'Imports integration org', 'America/Los_Angeles', 'USD'),
              ($2, 'Imports other org', 'America/Los_Angeles', 'USD')`,
      [orgId, otherOrgId],
    );
    await client.query(
      `insert into public.memberships (org_id, auth_user_id, role)
       values ($1, $2, 'owner'), ($1, $3, 'operator'), ($4, $5, 'owner')`,
      [orgId, ownerId, operatorId, otherOrgId, otherUserId],
    );
    await client.query(
      `insert into public.locations (id, org_id, name, external_id, timezone)
       values ($1, $2, 'Main warehouse', 'MAIN-WAREHOUSE', 'America/Los_Angeles')`,
      [locationId, orgId],
    );
  });

  afterAll(async () => {
    await client.end();
  });

  it("AT-01 activates the harbor fixture and projects the golden shortage", async () => {
    const staged = await stageImport();
    expect(staged.outcome).toBe("staged");
    const importId = staged.import_id as string;

    const activated = await activateImport({ importId });
    expect(activated.outcome).toBe("activated");

    const loaded = await client.query<{ facts: unknown }>(
      "select public.load_projection_facts($1::uuid, $2::uuid, $3::uuid) as facts",
      [orgId, (await client.query<{ id: string }>(
        "select id from public.items where org_id = $1 and external_id = 'CARTON-ITEM'",
        [orgId],
      )).rows[0].id, locationId],
    );
    const facts = jsonb<ProjectionFacts>(loaded.rows[0].facts);
    const built = buildProjectionInput(facts);
    expect(built.input).not.toBeNull();
    const projection = projectInventory(built.input!);
    expect(projection).toMatchObject({
      firstShortageAt: expected.first_shortage_at,
      bridgeQuantity: expected.bridge_quantity,
      requirements: expected.requirements.map((requirement) => ({
        by: requirement.by,
        cumulativeQuantity: requirement.cumulative_quantity,
      })),
    });
  });

  it("AT-02 stores invalid imports without changing the active snapshot and rolls back failed activation", async () => {
    const priorDataset = await client.query<{ id: string }>(
      "select id from public.datasets where org_id = $1 and status = 'active'",
      [orgId],
    );
    const invalidFiles = { ...baseFiles, "inventory.csv": baseFiles["inventory.csv"].replace("600,0,0", "1,2,0") };
    const invalid = await stageImport(invalidFiles);
    expect(invalid.outcome).toBe("invalid");
    expect(invalid.status).toBe("invalid");
    expect(invalid.dataset_id).toBeNull();
    expect(invalid.validation_summary).toMatchObject({
      errors: [expect.objectContaining({
        file: "inventory.csv",
        row: 2,
        field: "outside_allocations_qty",
        code: "contradictory_stock",
      })],
    });
    expect(await countRows(
      "select count(*)::text as count from public.datasets where org_id = $1 and status = 'active'",
      [orgId],
    )).toBe(1);
    expect((await client.query<{ id: string }>(
      "select id from public.datasets where org_id = $1 and status = 'active'",
      [orgId],
    )).rows[0].id).toBe(priorDataset.rows[0].id);

    const rollbackPayload: NormalizedImport = {
      suppliers: [{
        external_id: "ROLLBACK-SUPPLIER",
        name: "Rollback supplier",
        purchasing_status: "candidate",
        contacts: [],
      }],
      items: [{
        external_id: "ROLLBACK-ITEM",
        sku: "ROLLBACK-SKU",
        description: "Rollback item",
        base_unit: "carton",
        specification: {
          length_mm: 1,
          width_mm: 1,
          height_mm: 1,
          material_grade: "TEST",
        },
      }],
      purchase_orders: [{
        external_id: "ROLLBACK-PO",
        supplier_external_id: "ROLLBACK-SUPPLIER",
        currency: "USD",
        status: "open",
      }],
      purchase_order_lines: [{
        po_external_id: "ROLLBACK-PO",
        external_line_id: "1",
        item_external_id: "ROLLBACK-ITEM",
        location_external_id: "MISSING-WAREHOUSE",
        ordered_qty: 10,
        received_qty: 0,
        cancelled_qty: 0,
        unit_price_minor: "25",
        original_due_at: null,
      }],
      receipt_schedules: [],
      inventory: [],
      demand: [],
      metadata,
    };
    const outboxBefore = await countRows(
      "select count(*)::text as count from public.event_outbox where org_id = $1 and event_type = 'business.snapshot.activated'",
      [orgId],
    );
    const rollback = await stageImport(baseFiles, `rollback-${randomUUID()}`, {
      payload: rollbackPayload,
      contentHash: `rollback-${randomUUID()}`,
      valid: true,
    });
    await expect(activateImport({ importId: rollback.import_id as string })).rejects.toThrow();

    expect((await client.query<{ id: string }>(
      "select id from public.datasets where org_id = $1 and status = 'active'",
      [orgId],
    )).rows[0].id).toBe(priorDataset.rows[0].id);
    expect(await countRows(
      "select count(*)::text as count from public.event_outbox where org_id = $1 and event_type = 'business.snapshot.activated'",
      [orgId],
    )).toBe(outboxBefore);
    for (const [table, column, value] of [
      ["suppliers", "external_id", "ROLLBACK-SUPPLIER"],
      ["items", "external_id", "ROLLBACK-ITEM"],
      ["purchase_orders", "external_id", "ROLLBACK-PO"],
    ]) {
      expect(await countRows(
        `select count(*)::text as count from public.${table} where org_id = $1 and ${column} = $2`,
        [orgId, value],
      )).toBe(0);
    }
  });

  it("AT-02 no-ops identical content and supersedes changed datasets atomically", async () => {
    const sessionCountBefore = await countRows(
      "select count(*)::text as count from public.import_sessions where org_id = $1",
      [orgId],
    );
    const datasetCountBefore = await countRows(
      "select count(*)::text as count from public.datasets where org_id = $1",
      [orgId],
    );
    const outboxBefore = await countRows(
      "select count(*)::text as count from public.event_outbox where org_id = $1 and event_type = 'business.snapshot.activated'",
      [orgId],
    );
    const noOp = await stageImport(baseFiles, `same-${randomUUID()}`);
    expect(noOp.outcome).toBe("noop_same_content");
    expect(await countRows(
      "select count(*)::text as count from public.import_sessions where org_id = $1",
      [orgId],
    )).toBe(sessionCountBefore);
    expect(await countRows(
      "select count(*)::text as count from public.datasets where org_id = $1",
      [orgId],
    )).toBe(datasetCountBefore);
    expect(await countRows(
      "select count(*)::text as count from public.event_outbox where org_id = $1 and event_type = 'business.snapshot.activated'",
      [orgId],
    )).toBe(outboxBefore);

    const changedFiles = {
      ...baseFiles,
      "inventory.csv": baseFiles["inventory.csv"].replace("600,0,0", "1500,0,0"),
    };
    const staged = await stageImport(changedFiles);
    expect(staged.outcome).toBe("staged");
    const activated = await activateImport({ importId: staged.import_id as string });
    expect(activated.outcome).toBe("activated");
    expect(activated.superseded_dataset_id).toBe(noOp.dataset_id);

    expect(await countRows(
      "select count(*)::text as count from public.datasets where org_id = $1 and status = 'active'",
      [orgId],
    )).toBe(1);
    expect((await client.query<{ status: string }>(
      "select status from public.datasets where id = $1",
      [noOp.dataset_id],
    )).rows[0].status).toBe("superseded");
    expect(await countRows(
      "select count(*)::text as count from public.receipt_schedules where org_id = $1 and dataset_id = $2 and promise_state = 'superseded'",
      [orgId, noOp.dataset_id],
    )).toBe(1);
    expect(await countRows(
      `select count(*)::text as count
         from public.receipt_schedules new
         join public.receipt_schedules old
           on old.id = new.supersedes_id
          and old.org_id = new.org_id
        where new.org_id = $1
          and new.dataset_id = $2
          and old.dataset_id = $3`,
      [orgId, activated.dataset_id, noOp.dataset_id],
    )).toBe(1);
    expect(await countRows(
      "select count(*)::text as count from public.event_outbox where org_id = $1 and event_type = 'business.snapshot.activated'",
      [orgId],
    )).toBe(outboxBefore + 1);

    const itemId = (await client.query<{ id: string }>(
      "select id from public.items where org_id = $1 and external_id = 'CARTON-ITEM'",
      [orgId],
    )).rows[0].id;
    const loaded = await client.query<{ facts: unknown }>(
      "select public.load_projection_facts($1::uuid, $2::uuid, $3::uuid) as facts",
      [orgId, itemId, locationId],
    );
    const built = buildProjectionInput(jsonb<ProjectionFacts>(loaded.rows[0].facts));
    expect(built.input).not.toBeNull();
    expect(projectInventory(built.input!).bridgeQuantity).toBe(0);
    expect(projectInventory(built.input!).firstShortageAt).toBeNull();
  });

  it("AT-02 rejects stale activation versions and replays activation idempotently", async () => {
    const files = {
      ...baseFiles,
      "inventory.csv": baseFiles["inventory.csv"].replace("600,0,0", "1501,0,0"),
    };
    const staged = await stageImport(files);
    const stale = await activateImport({
      importId: staged.import_id as string,
      expectedVersion: 2,
    });
    expect(stale).toMatchObject({ outcome: "version_conflict", row_version: 1 });

    const activationKey = `versioned-${randomUUID()}`;
    const activated = await activateImport({
      importId: staged.import_id as string,
      idempotencyKey: activationKey,
    });
    expect(activated.outcome).toBe("activated");
    const replay = await activateImport({
      importId: staged.import_id as string,
      expectedVersion: 1,
      idempotencyKey: activationKey,
    });
    expect(replay).toMatchObject({
      outcome: "already_active",
      dataset_id: activated.dataset_id,
      row_version: 2,
    });
  });

  it("AT-02 gates contact authority to owners and explicit permission confirmation", async () => {
    const approvedFiles = {
      ...baseFiles,
      "suppliers.csv": baseFiles["suppliers.csv"].replaceAll(",false", ",true"),
      "inventory.csv": baseFiles["inventory.csv"].replace("600,0,0", "1502,0,0"),
    };
    const noConfirmation = await stageImport(approvedFiles);
    const firstActivation = await activateImport({
      importId: noConfirmation.import_id as string,
      contactPermissionsConfirmed: false,
    });
    expect(firstActivation.outcome).toBe("activated");
    let contact = await client.query<{
      outreach_approved_at: string | null;
      outreach_approved_by: string | null;
      permitted_channels: string[];
    }>(
      `select outreach_approved_at, outreach_approved_by, permitted_channels
         from public.supplier_contacts
        where org_id = $1
          and normalized_address = 'alyssa@baycarton.example.com'`,
      [orgId],
    );
    expect(contact.rows[0]).toMatchObject({
      outreach_approved_at: null,
      outreach_approved_by: null,
      permitted_channels: [],
    });

    const operatorImport = await stageImport({
      ...approvedFiles,
      "inventory.csv": approvedFiles["inventory.csv"].replace("1502,0,0", "1503,0,0"),
    });
    const forbidden = await activateImport({
      importId: operatorImport.import_id as string,
      actorId: operatorId,
      role: "operator",
      contactPermissionsConfirmed: true,
    });
    expect(forbidden.outcome).toBe("forbidden_contact_confirmation");

    const ownerActivation = await activateImport({
      importId: operatorImport.import_id as string,
      contactPermissionsConfirmed: true,
    });
    expect(ownerActivation.outcome).toBe("activated");
    contact = await client.query(
      `select outreach_approved_at, outreach_approved_by, permitted_channels
         from public.supplier_contacts
        where org_id = $1
          and normalized_address = 'alyssa@baycarton.example.com'`,
      [orgId],
    );
    expect(contact.rows[0].outreach_approved_at).not.toBeNull();
    expect(contact.rows[0].outreach_approved_by).toBe(ownerId);
    expect(contact.rows[0].permitted_channels).toEqual(["email"]);
  });

  it("AT-02 isolates tenant reads and restricts import function execution", async () => {
    await client.query("begin");
    await client.query("set local role authenticated");
    await client.query(
      "select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)",
      [otherUserId, JSON.stringify({ sub: otherUserId, role: "authenticated" })],
    );
    const sessions = await client.query("select id from public.import_sessions where org_id = $1", [orgId]);
    const payloads = await client.query("select import_session_id from public.import_payloads where org_id = $1", [orgId]);
    const datasets = await client.query("select id from public.datasets where org_id = $1", [orgId]);
    expect(sessions.rows).toEqual([]);
    expect(payloads.rows).toEqual([]);
    expect(datasets.rows).toEqual([]);
    await client.query("rollback");

    await client.query("begin");
    await client.query("set local role authenticated");
    await client.query(
      "select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)",
      [otherUserId, JSON.stringify({ sub: otherUserId, role: "authenticated" })],
    );
    await expect(client.query(
      `select public.stage_import(
         $1::uuid, $2::uuid, 'blocked', 'hash', 'hash', $3::timestamptz,
         false, '{}'::jsonb, null
       )`,
      [orgId, otherUserId, fixtureClock],
    )).rejects.toThrow();
    await client.query("rollback");

    await client.query("begin");
    await client.query("set local role authenticated");
    await client.query(
      "select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)",
      [otherUserId, JSON.stringify({ sub: otherUserId, role: "authenticated" })],
    );
    await expect(client.query(
      `select public.activate_import(
         $1::uuid, $2::uuid, 1, $3::uuid, 'owner'::public.membership_role, false, 'blocked'
       )`,
      [orgId, randomUUID(), otherUserId],
    )).rejects.toThrow();
    await client.query("rollback");
  });
});
