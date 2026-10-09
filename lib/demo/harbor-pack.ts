import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { createServiceClient } from "@/lib/db/service";
import { QueryError } from "@/lib/db/queries/client";
import {
  HARBOR_PACK_FIXTURE_CLOCK,
  HARBOR_PACK_FIXTURES,
  HARBOR_PACK_TIMES,
  type HarborPackFixtureId,
} from "./fixtures";

// Seed rows span several dynamic PostgREST relations.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export interface LoadHarborPackInput {
  orgId: string;
  fixtureId: HarborPackFixtureId;
  reset: boolean;
  now: Date;
  client?: ReturnType<typeof createServiceClient>;
}

export interface LoadHarborPackResult {
  org_id: string;
  fixture_id: HarborPackFixtureId;
  dataset_id: string;
  case_id: string;
  phase: string;
  reset: boolean;
  data_label: "Replay";
}

const fixtureFiles = [
  "README.md",
  "items.csv",
  "suppliers.csv",
  "inventory.csv",
  "demand.csv",
  "purchase_orders.csv",
  "purchase_order_lines.csv",
  "receipt_schedules.csv",
  "messages/delay-po-1042.eml",
];

function failDatabase(error: { code?: string } | null, operation: string): void {
  if (error) {
    throw new Error(`Harbor Pack ${operation} failed (${error.code ?? "database_error"})`);
  }
}

async function result<T>(
  query: PromiseLike<{ data: T | null; error: { code?: string } | null }>,
  operation: string,
): Promise<T> {
  const response = await query;
  failDatabase(response.error, operation);
  if (response.data === null) {
    throw new Error(`Harbor Pack ${operation} returned no row`);
  }
  return response.data;
}

async function upsert(
  client: ReturnType<typeof createServiceClient>,
  table: string,
  value: Row,
  conflict: string,
): Promise<Row> {
  return result(
    client.from(table).upsert(value, { onConflict: conflict }).select("*").single(),
    `upsert ${table}`,
  );
}

async function maybeOne(
  client: ReturnType<typeof createServiceClient>,
  table: string,
  // Relation filters are composed per caller.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: (tableQuery: any) => any,
): Promise<Row | null> {
  const response = await query(client.from(table).select("*").limit(1).maybeSingle());
  failDatabase(response.error, `read ${table}`);
  return response.data ?? null;
}

async function insert(
  client: ReturnType<typeof createServiceClient>,
  table: string,
  value: Row,
): Promise<Row> {
  return result(client.from(table).insert(value).select("*").single(), `insert ${table}`);
}

async function fixtureHash(): Promise<string> {
  const hash = createHash("sha256");
  const base = path.join(process.cwd(), "tests", "fixtures", "harbor-pack");
  for (const relativePath of fixtureFiles) {
    const content = await readFile(path.join(base, relativePath));
    hash.update(relativePath).update("\0").update(content).update("\0");
  }
  return hash.digest("hex");
}

function stableId(seed: string): string {
  const bytes = createHash("sha256").update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function ensureEvidence(
  client: ReturnType<typeof createServiceClient>,
  input: {
    orgId: string;
    sourceType: string;
    content: string;
    sourceTime: string;
    excerpt: string;
    locator: string;
    verifiedAt: string | null;
    seed: string;
  },
): Promise<Row> {
  const contentHash = createHash("sha256").update(input.content).digest("hex");
  const existing = await maybeOne(
    client,
    "evidence",
    (query) => query.eq("org_id", input.orgId).eq("content_hash", contentHash),
  );
  if (existing) return existing;
  return insert(client, "evidence", {
    id: stableId(`${input.orgId}:evidence:${input.seed}`),
    org_id: input.orgId,
    source_type: input.sourceType,
    content_hash: contentHash,
    locator: input.locator,
    supported_excerpt: input.excerpt,
    source_time: input.sourceTime,
    captured_at: HARBOR_PACK_FIXTURE_CLOCK,
    verified_at: input.verifiedAt,
  });
}

async function ensureDataset(
  client: ReturnType<typeof createServiceClient>,
  orgId: string,
  fixtureId: HarborPackFixtureId,
  hash: string,
  reset: boolean,
): Promise<Row> {
  if (!reset) {
    const existing = await maybeOne(
      client,
      "datasets",
      (query) =>
        query.eq("org_id", orgId)
          .eq("source_type", "fixture")
          .eq("content_hash", hash)
          .eq("status", "active"),
    );
    if (existing) return existing;
  } else {
    const { error } = await client.from("datasets")
      .update({ status: "superseded", updated_at: new Date().toISOString() })
      .eq("org_id", orgId)
      .eq("source_type", "fixture")
      .in("validation_summary->>fixture_id", [
        "harbor-pack-canonical",
        "harbor-pack-harmless",
      ])
      .neq("status", "superseded");
    failDatabase(error, "supersede fixture datasets");
  }
  return insert(client, "datasets", {
    org_id: orgId,
    source_type: "fixture",
    schema_version: 1,
    source_as_of: HARBOR_PACK_FIXTURE_CLOCK,
    content_hash: hash,
    status: "active",
    validation_summary: { fixture_id: fixtureId },
  });
}

async function upsertFixtureRows(
  client: ReturnType<typeof createServiceClient>,
  orgId: string,
): Promise<{
  item: Row;
  alternativeItem: Row;
  location: Row;
  suppliers: Map<string, Row>;
  contacts: Map<string, Row>;
  purchaseOrder: Row;
  poLine: Row;
}> {
  const item = await upsert(
    client,
    "items",
    {
      org_id: orgId,
      sku: "CARTON-302015",
      description: "Shipping carton",
      base_unit: "carton",
      specification: {
        length_mm: 300,
        width_mm: 200,
        height_mm: 150,
        material_grade: "KRAFT-SW-DEMO",
      },
    },
    "org_id,sku",
  );
  const alternativeItem = await upsert(
    client,
    "items",
    {
      org_id: orgId,
      sku: "BUDGET-BOX-ALT",
      description: "Budget Box advertised alternative (incompatible)",
      base_unit: "carton",
      specification: {
        length_mm: 350,
        width_mm: 250,
        height_mm: 200,
        material_grade: "KRAFT-STD",
      },
    },
    "org_id,sku",
  );
  const location = await upsert(
    client,
    "locations",
    {
      org_id: orgId,
      name: "Main Warehouse",
      external_id: "MAIN-WAREHOUSE",
      timezone: "America/Los_Angeles",
      destination_address: {},
    },
    "org_id,name",
  );
  const supplierSpecs = [
    {
      key: "BAY-CARTON",
      name: "Bay Carton",
      status: "approved",
      contactName: "Alyssa Reed",
      email: "alyssa@baycarton.example.com",
      phone: null,
    },
    {
      key: "NORTH-PACKAGING",
      name: "North Packaging",
      status: "approved",
      contactName: "Jordan Lee",
      email: "jordan@northpackaging.example.com",
      phone: null,
    },
    {
      key: "BUDGET-BOX",
      name: "Budget Box",
      status: "candidate",
      contactName: "Casey Morgan",
      email: "casey@budgetbox.example.com",
      phone: null,
    },
    {
      key: "QUICK-PACK",
      name: "Quick Pack",
      status: "candidate",
      contactName: "Riley Chen",
      email: "riley@quickpack.example.com",
      phone: null,
    },
  ];
  const suppliers = new Map<string, Row>();
  const contacts = new Map<string, Row>();
  for (const specification of supplierSpecs) {
    const supplier = await upsert(
      client,
      "suppliers",
      {
        org_id: orgId,
        name: specification.name,
        purchasing_status: specification.status,
      },
      "org_id,name",
    );
    suppliers.set(specification.key, supplier);
    const contact = await upsert(
      client,
      "supplier_contacts",
      {
        org_id: orgId,
        supplier_id: supplier.id,
        channel: "email",
        normalized_address: specification.email,
        display_name: specification.contactName,
        timezone: "America/Los_Angeles",
        permitted_channels: ["email"],
        outreach_approved_at: null,
        outreach_approved_by: null,
      },
      "org_id,channel,normalized_address",
    );
    contacts.set(specification.key, contact);
  }
  const bayCarton = suppliers.get("BAY-CARTON")!;
  const purchaseOrder = await upsert(
    client,
    "purchase_orders",
    {
      org_id: orgId,
      external_id: "PO-1042",
      supplier_id: bayCarton.id,
      currency: "USD",
      status: "open",
    },
    "org_id,external_id",
  );
  const poLine = await upsert(
    client,
    "purchase_order_lines",
    {
      org_id: orgId,
      purchase_order_id: purchaseOrder.id,
      external_line_id: "1",
      item_id: item.id,
      destination_location_id: location.id,
      ordered_qty: 4000,
      received_qty: 0,
      cancelled_qty: 0,
      unit_price_minor: 35,
      original_due_at: HARBOR_PACK_TIMES.originalDueAt,
    },
    "org_id,purchase_order_id,external_line_id",
  );
  return {
    item,
    alternativeItem,
    location,
    suppliers,
    contacts,
    purchaseOrder,
    poLine,
  };
}

async function ensureReceiptSchedules(
  client: ReturnType<typeof createServiceClient>,
  orgId: string,
  datasetId: string,
  poLineId: string,
  evidenceId: string,
): Promise<void> {
  const original = await maybeOne(
    client,
    "receipt_schedules",
    (query) =>
      query.eq("org_id", orgId)
        .eq("po_line_id", poLineId)
        .eq("source_as_of", HARBOR_PACK_FIXTURE_CLOCK)
        .eq("promise_state", "superseded")
        .is("supersedes_id", null),
  );
  const originalRow = original ?? await insert(client, "receipt_schedules", {
    org_id: orgId,
    po_line_id: poLineId,
    quantity_remaining: 4000,
    earliest_at: HARBOR_PACK_TIMES.originalDueAt,
    latest_at: HARBOR_PACK_TIMES.originalDueAt,
    promise_state: "superseded",
    supersedes_id: null,
    source_as_of: HARBOR_PACK_FIXTURE_CLOCK,
  });
  const delayed = await maybeOne(
    client,
    "receipt_schedules",
    (query) =>
      query.eq("org_id", orgId)
        .eq("po_line_id", poLineId)
        .eq("source_as_of", HARBOR_PACK_FIXTURE_CLOCK)
        .eq("promise_state", "confirmed")
        .eq("latest_at", HARBOR_PACK_TIMES.delayedArrivalAt),
  );
  if (!delayed) {
    await insert(client, "receipt_schedules", {
      org_id: orgId,
      po_line_id: poLineId,
      quantity_remaining: 4000,
      earliest_at: HARBOR_PACK_TIMES.delayedArrivalAt,
      latest_at: HARBOR_PACK_TIMES.delayedArrivalAt,
      evidence_id: evidenceId,
      promise_state: "confirmed",
      supersedes_id: originalRow.id,
      source_as_of: HARBOR_PACK_FIXTURE_CLOCK,
    });
  }
  void datasetId;
}

async function ensureDemand(
  client: ReturnType<typeof createServiceClient>,
  orgId: string,
  datasetId: string,
  itemId: string,
  locationId: string,
): Promise<void> {
  for (const [index, requiredAt] of HARBOR_PACK_TIMES.demandAt.entries()) {
    const externalId = `DEMAND-101${3 + index}`;
    const existing = await maybeOne(
      client,
      "demand_requirements",
      (query) =>
        query.eq("org_id", orgId)
          .eq("dataset_id", datasetId)
          .eq("external_id", externalId),
    );
    if (!existing) {
      await insert(client, "demand_requirements", {
        org_id: orgId,
        dataset_id: datasetId,
        external_id: externalId,
        item_id: itemId,
        location_id: locationId,
        remaining_qty: 400,
        required_at: requiredAt,
        certainty: "confirmed",
        included_reserved_qty: 0,
        status: "open",
        source_as_of: HARBOR_PACK_FIXTURE_CLOCK,
      });
    }
  }
}

async function ensureInventory(
  client: ReturnType<typeof createServiceClient>,
  orgId: string,
  datasetId: string,
  itemId: string,
  locationId: string,
  physicalQuantity: number,
): Promise<void> {
  await upsert(
    client,
    "inventory_snapshots",
    {
      org_id: orgId,
      dataset_id: datasetId,
      item_id: itemId,
      location_id: locationId,
      physical_qty: physicalQuantity,
      unusable_qty: 0,
      outside_allocations_qty: 0,
      source_as_of: HARBOR_PACK_FIXTURE_CLOCK,
    },
    "org_id,dataset_id,item_id,location_id",
  );
}

async function ensureSourceMessage(
  client: ReturnType<typeof createServiceClient>,
  orgId: string,
  evidenceId: string,
): Promise<string> {
  const existing = await maybeOne(
    client,
    "source_messages",
    (query) => query.eq("org_id", orgId)
      .eq("provider_message_id", "<delay-po-1042@baycarton.example.com>"),
  );
  if (existing) return existing.id;
  const row = await insert(client, "source_messages", {
    org_id: orgId,
    connection_id: null,
    provider_message_id: "<delay-po-1042@baycarton.example.com>",
    provider_thread_id: "PO-1042",
    rfc_message_id: "<delay-po-1042@baycarton.example.com>",
    direction: "inbound",
    sender: "alyssa@baycarton.example.com",
    recipients: ["purchasing@harborpack.example.com"],
    sent_at: "2026-10-12T15:00:00.000Z",
    received_at: "2026-10-12T15:00:00.000Z",
    body_evidence_id: evidenceId,
    processing_state: "processed",
  });
  return row.id;
}

async function ensureSupplierItem(
  client: ReturnType<typeof createServiceClient>,
  orgId: string,
  supplierId: string,
  itemId: string,
  evidenceId: string | null,
): Promise<void> {
  const existing = await maybeOne(
    client,
    "supplier_items",
    (query) => query.eq("org_id", orgId)
      .eq("supplier_id", supplierId)
      .eq("item_id", itemId),
  );
  const value = {
    org_id: orgId,
    supplier_id: supplierId,
    item_id: itemId,
    supplier_sku: null,
    pack_size: 1,
    minimum_qty: 1,
    verified_specification_evidence_id: evidenceId,
    last_verified_at: evidenceId ? HARBOR_PACK_FIXTURE_CLOCK : null,
  };
  if (existing) {
    const { error } = await client.from("supplier_items").update(value)
      .eq("org_id", orgId).eq("id", existing.id);
    failDatabase(error, "update supplier specification");
  } else {
    await upsert(client, "supplier_items", value, "org_id,supplier_id,item_id");
  }
}

async function ensureCase(
  client: ReturnType<typeof createServiceClient>,
  orgId: string,
  fixtureId: HarborPackFixtureId,
  itemId: string,
  locationId: string,
  now: Date,
  reset: boolean,
): Promise<Row> {
  const activeCases = await result(
    client.from("cases").select("*")
      .eq("org_id", orgId)
      .eq("item_id", itemId)
      .eq("location_id", locationId)
      .neq("phase", "closed"),
    "read active cases",
  ) as Row[];
  if (!reset && activeCases.length > 0) {
    const caseRow = activeCases[0];
    const assessment = caseRow.current_assessment_id
      ? await maybeOne(
          client,
          "assessments",
          (query) => query.eq("org_id", orgId).eq("id", caseRow.current_assessment_id),
        )
      : null;
    if (assessment?.source_versions?.fixture_id === fixtureId) return caseRow;
    throw new QueryError("active_case_exists", 409, "Another active case already exists for this item and location");
  }
  if (reset) {
    for (const caseRow of activeCases) {
      const { error } = await client.from("cases").update({
        phase: "closed",
        closed_outcome: "cancelled",
        closed_reason: "Demo reset",
        row_version: caseRow.row_version + 1,
        updated_at: now.toISOString(),
      }).eq("org_id", orgId).eq("id", caseRow.id);
      failDatabase(error, "close prior demo case");
      await insert(client, "audit_events", {
        id: stableId(`harbor-pack-reset:${caseRow.id}:${caseRow.row_version + 1}`),
        org_id: orgId,
        actor_type: "system",
        actor_id: "harbor-pack-loader",
        case_id: caseRow.id,
        entity_type: "case",
        entity_id: caseRow.id,
        event_name: "demo.reset",
        previous_version: caseRow.row_version,
        new_version: caseRow.row_version + 1,
        reason: "Demo reset",
        occurred_at: now.toISOString(),
      });
    }
  }
  const definition = HARBOR_PACK_FIXTURES[fixtureId];
  return insert(client, "cases", {
    org_id: orgId,
    item_id: itemId,
    location_id: locationId,
    phase: definition.phase,
    run_control: "active",
    severity: definition.severity,
    next_check_at: fixtureId === "harbor-pack-canonical" ? HARBOR_PACK_TIMES.quoteValidUntil : null,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  });
}

async function ensureCaseOrderLine(
  client: ReturnType<typeof createServiceClient>,
  orgId: string,
  caseId: string,
  poLineId: string,
): Promise<void> {
  await upsert(
    client,
    "case_order_lines",
    { org_id: orgId, case_id: caseId, po_line_id: poLineId, affected_qty: 4000 },
    "org_id,case_id,po_line_id",
  );
}

async function ensureAssessment(
  client: ReturnType<typeof createServiceClient>,
  input: {
    orgId: string;
    fixtureId: HarborPackFixtureId;
    datasetId: string;
    caseId: string;
    itemUnit: string;
    inventory: number;
  },
): Promise<Row> {
  const canonical = input.fixtureId === "harbor-pack-canonical";
  const points = canonical
    ? [
        { kind: "start", at: HARBOR_PACK_FIXTURE_CLOCK, delta: 600, balance: 600, sourceId: "inventory", label: "On hand" },
        { kind: "demand", at: HARBOR_PACK_TIMES.demandAt[0], delta: -400, balance: 200, sourceId: "DEMAND-1013", label: "Confirmed demand" },
        { kind: "demand", at: HARBOR_PACK_TIMES.demandAt[1], delta: -400, balance: -200, sourceId: "DEMAND-1014", label: "Confirmed demand" },
        { kind: "demand", at: HARBOR_PACK_TIMES.demandAt[2], delta: -400, balance: -600, sourceId: "DEMAND-1015", label: "Confirmed demand" },
        { kind: "receipt", at: HARBOR_PACK_TIMES.delayedArrivalAt, delta: 4000, balance: 3400, sourceId: "PO-1042-RECEIPT", label: "Confirmed delayed receipt" },
      ]
    : [
        { kind: "start", at: HARBOR_PACK_FIXTURE_CLOCK, delta: input.inventory, balance: input.inventory, sourceId: "inventory", label: "On hand" },
        ...HARBOR_PACK_TIMES.demandAt.map((at, index) => ({
          kind: "demand",
          at,
          delta: -400,
          balance: input.inventory - 400 * (index + 1),
          sourceId: `DEMAND-101${3 + index}`,
          label: "Confirmed demand",
        })),
        { kind: "receipt", at: HARBOR_PACK_TIMES.delayedArrivalAt, delta: 4000, balance: input.inventory - 1200 + 4000, sourceId: "PO-1042-RECEIPT", label: "Confirmed delayed receipt" },
      ];
  return upsert(
    client,
    "assessments",
    {
      org_id: input.orgId,
      case_id: input.caseId,
      version: 1,
      input_fingerprint: createHash("sha256")
        .update(`${input.fixtureId}:${input.datasetId}:${input.inventory}`)
        .digest("hex"),
      source_versions: {
        mode: "replay",
        fixture_id: input.fixtureId,
        dataset_id: input.datasetId,
      },
      horizon_start: HARBOR_PACK_FIXTURE_CLOCK,
      horizon_end: HARBOR_PACK_TIMES.delayedArrivalAt,
      quality: "sufficient",
      first_shortage_at: canonical ? HARBOR_PACK_FIXTURES[input.fixtureId].firstShortageAt : null,
      bridge_qty: canonical ? HARBOR_PACK_FIXTURES[input.fixtureId].bridgeQuantity : null,
      projection: {
        points,
        missing_facts: [],
      },
      dated_requirements: canonical
        ? [
            { by: "2026-10-14T16:00:00.000Z", cumulative_quantity: 200 },
            { by: "2026-10-15T16:00:00.000Z", cumulative_quantity: 600 },
          ]
        : [],
      evidence_ids: [],
    },
    "org_id,case_id,version",
  );
}

async function ensureOffer(
  client: ReturnType<typeof createServiceClient>,
  orgId: string,
  caseId: string,
  supplier: Row,
  contact: Row,
  evidenceId: string,
  sourceSummary: string,
): Promise<Row> {
  const existing = await maybeOne(
    client,
    "offers",
    (query) =>
      query.eq("org_id", orgId)
        .eq("case_id", caseId)
        .eq("supplier_id", supplier.id),
  );
  if (existing) return existing;
  return insert(client, "offers", {
    org_id: orgId,
    case_id: caseId,
    supplier_id: supplier.id,
    contact_id: contact.id,
    evidence_ids: [evidenceId],
    received_at: HARBOR_PACK_FIXTURE_CLOCK,
    source_type: "email",
    source_summary: sourceSummary,
  });
}

async function ensureQuote(
  client: ReturnType<typeof createServiceClient>,
  input: Row,
): Promise<Row> {
  const existing = await maybeOne(
    client,
    "quotes",
    (query) =>
      query.eq("org_id", input.org_id)
        .eq("case_id", input.case_id)
        .eq("supplier_id", input.supplier_id),
  );
  if (existing) return existing;
  return insert(client, "quotes", input);
}

async function ensurePlan(
  client: ReturnType<typeof createServiceClient>,
  input: {
    orgId: string;
    caseId: string;
    assessmentId: string;
    version: number;
    status: string;
    quote: Row;
    supplier: Row;
    evidenceIds: string[];
    itemId: string;
    itemUnit: string;
    locationId: string;
    quantity: number;
    summary: string;
    grossMinor: number;
    incrementalMinor: number;
  },
): Promise<Row> {
  const plan = await upsert(
    client,
    "recovery_plans",
    {
      org_id: input.orgId,
      case_id: input.caseId,
      version: input.version,
      assessment_id: input.assessmentId,
      input_fingerprint: createHash("sha256")
        .update(`${input.quote.id}:${input.grossMinor}:${input.incrementalMinor}`)
        .digest("hex"),
      status: input.status,
      gross_commitment_minor: input.grossMinor,
      incremental_cost_minor: input.incrementalMinor,
      expires_at: input.quote.valid_until,
      dependencies: [
        { quote_id: input.quote.id, supplier_id: input.supplier.id, description: input.summary },
      ],
      evidence_ids: input.evidenceIds,
    },
    "org_id,case_id,version",
  );
  await upsert(
    client,
    "plan_steps",
    {
      org_id: input.orgId,
      plan_id: plan.id,
      step_id: `step-${input.version}`,
      kind: input.version === 1 ? "amend_delivery_schedule" : "purchase_bridge",
      item_id: input.itemId,
      quantity: input.quantity,
      unit: input.itemUnit,
      destination_location_id: input.locationId,
      depends_on_step_ids: [],
      evidence_ids: input.evidenceIds,
      execution_mode: "manual",
      payload: { summary: input.summary, supplier_id: input.supplier.id },
      missing_fields: [],
    },
    "org_id,plan_id,step_id",
  );
  return plan;
}

async function ensureAuditEvent(
  client: ReturnType<typeof createServiceClient>,
  input: {
    orgId: string;
    caseId: string;
    seed: string;
    at: string;
    eventName: string;
    title: string;
    actorType: "system" | "agent";
    evidenceIds: string[];
  },
): Promise<void> {
  const id = stableId(`${input.orgId}:${input.caseId}:${input.seed}`);
  const existing = await maybeOne(
    client,
    "audit_events",
    (query) => query.eq("org_id", input.orgId).eq("id", id),
  );
  if (existing) return;
  await insert(client, "audit_events", {
    id,
    org_id: input.orgId,
    actor_type: input.actorType,
    actor_id: input.actorType === "system" ? "harbor-pack-loader" : "replay",
    case_id: input.caseId,
    entity_type: "case",
    entity_id: input.caseId,
    event_name: input.eventName,
    reason: input.title,
    request_id: stableId(`${id}:request`),
    occurred_at: input.at,
  });
  for (const evidenceId of input.evidenceIds) {
    const link = await maybeOne(
      client,
      "case_evidence",
      (query) =>
        query.eq("org_id", input.orgId)
          .eq("case_id", input.caseId)
          .eq("evidence_id", evidenceId)
          .eq("purpose", input.eventName),
    );
    if (!link) {
      await upsert(
        client,
        "case_evidence",
        {
          org_id: input.orgId,
          case_id: input.caseId,
          evidence_id: evidenceId,
          purpose: input.eventName,
        },
        "org_id,case_id,evidence_id,purpose",
      );
    }
  }
}

async function loadCanonicalData(
  client: ReturnType<typeof createServiceClient>,
  input: {
    orgId: string;
    fixtureId: HarborPackFixtureId;
    datasetId: string;
    caseId: string;
    item: Row;
    alternativeItem: Row;
    location: Row;
    suppliers: Map<string, Row>;
    contacts: Map<string, Row>;
    poLine: Row;
    now: Date;
    inventory: number;
  },
): Promise<void> {
  const email = await readFile(
    path.join(process.cwd(), "tests", "fixtures", "harbor-pack", "messages", "delay-po-1042.eml"),
    "utf8",
  );
  const delayEvidence = await ensureEvidence(client, {
    orgId: input.orgId,
    sourceType: "email",
    content: email,
    sourceTime: "2026-10-12T15:00:00.000Z",
    excerpt:
      "The 4,000 cartons on PO-1042 that were originally due Tuesday, October 13 will now arrive Friday, October 16 at 8:00 AM. We apologize for the delay.",
    locator: "delay-po-1042.eml#body",
    verifiedAt: HARBOR_PACK_FIXTURE_CLOCK,
    seed: `${input.fixtureId}:delay-email`,
  });
  const [bayOfferContent, northOfferContent, budgetOfferContent, specContent] = [
    "Bay Carton confirms the split shipment: 600 cartons on October 14 and 3,400 cartons on October 16; freight USD 75.",
    "North Packaging confirms 600 compatible cartons for USD 0.42 each plus USD 60 freight, arriving October 14.",
    "Budget Box confirms 600 cartons, dimensions 350 x 250 x 200 mm.",
    "Supplier item specification verified against the Harbor Pack CARTON-302015 specification.",
  ];
  const [bayEvidence, northEvidence, budgetEvidence, specEvidence, alternativeSpecEvidence] =
    await Promise.all([
      ensureEvidence(client, {
        orgId: input.orgId,
        sourceType: "email",
        content: bayOfferContent,
        sourceTime: HARBOR_PACK_FIXTURE_CLOCK,
        excerpt: bayOfferContent,
        locator: "bay-carton-offer.eml#body",
        verifiedAt: HARBOR_PACK_FIXTURE_CLOCK,
        seed: `${input.fixtureId}:bay-offer`,
      }),
      ensureEvidence(client, {
        orgId: input.orgId,
        sourceType: "email",
        content: northOfferContent,
        sourceTime: HARBOR_PACK_FIXTURE_CLOCK,
        excerpt: northOfferContent,
        locator: "north-packaging-offer.eml#body",
        verifiedAt: HARBOR_PACK_FIXTURE_CLOCK,
        seed: `${input.fixtureId}:north-offer`,
      }),
      ensureEvidence(client, {
        orgId: input.orgId,
        sourceType: "email",
        content: budgetOfferContent,
        sourceTime: HARBOR_PACK_FIXTURE_CLOCK,
        excerpt: budgetOfferContent,
        locator: "budget-box-offer.eml#body",
        verifiedAt: HARBOR_PACK_FIXTURE_CLOCK,
        seed: `${input.fixtureId}:budget-offer`,
      }),
      ensureEvidence(client, {
        orgId: input.orgId,
        sourceType: "supplier_specification",
        content: specContent,
        sourceTime: HARBOR_PACK_FIXTURE_CLOCK,
        excerpt: specContent,
        locator: "bay-carton-specification.pdf#page=1",
        verifiedAt: HARBOR_PACK_FIXTURE_CLOCK,
        seed: `${input.fixtureId}:bay-spec`,
      }),
      ensureEvidence(client, {
        orgId: input.orgId,
        sourceType: "supplier_specification",
        content: "Budget Box product dimensions are 350 × 250 × 200 mm.",
        sourceTime: HARBOR_PACK_FIXTURE_CLOCK,
        excerpt: "Dimensions 350 × 250 × 200 mm do not match required 300 × 200 × 150 mm.",
        locator: "budget-box-specification.pdf#page=1",
        verifiedAt: HARBOR_PACK_FIXTURE_CLOCK,
        seed: `${input.fixtureId}:budget-spec`,
      }),
    ]);
  const messageId = await ensureSourceMessage(client, input.orgId, delayEvidence.id);
  await ensureReceiptSchedules(
    client,
    input.orgId,
    input.datasetId,
    input.poLine.id,
    delayEvidence.id,
  );
  await ensureDemand(
    client,
    input.orgId,
    input.datasetId,
    input.item.id,
    input.location.id,
  );
  await ensureInventory(
    client,
    input.orgId,
    input.datasetId,
    input.item.id,
    input.location.id,
    input.inventory,
  );
  const assessment = await ensureAssessment(client, {
    orgId: input.orgId,
    fixtureId: input.fixtureId,
    datasetId: input.datasetId,
    caseId: input.caseId,
    itemUnit: input.item.base_unit,
    inventory: input.inventory,
  });
  const { error: caseOrderError } = await client.from("case_order_lines")
    .upsert({
      org_id: input.orgId,
      case_id: input.caseId,
      po_line_id: input.poLine.id,
      affected_qty: 4000,
      triggering_message_id: messageId,
    }, { onConflict: "org_id,case_id,po_line_id" });
  failDatabase(caseOrderError, "upsert case purchase order line");
  const canonical = input.fixtureId === "harbor-pack-canonical";
  if (canonical) {
    const baySupplier = input.suppliers.get("BAY-CARTON")!;
    const northSupplier = input.suppliers.get("NORTH-PACKAGING")!;
    const budgetSupplier = input.suppliers.get("BUDGET-BOX")!;
    await Promise.all([
      ensureSupplierItem(client, input.orgId, baySupplier.id, input.item.id, specEvidence.id),
      ensureSupplierItem(client, input.orgId, northSupplier.id, input.item.id, specEvidence.id),
      ensureSupplierItem(client, input.orgId, budgetSupplier.id, input.alternativeItem.id, alternativeSpecEvidence.id),
    ]);
    const [bayOffer, northOffer, budgetOffer] = await Promise.all([
      ensureOffer(
        client, input.orgId, input.caseId, baySupplier, input.contacts.get("BAY-CARTON")!,
        bayEvidence.id, bayOfferContent,
      ),
      ensureOffer(
        client, input.orgId, input.caseId, northSupplier, input.contacts.get("NORTH-PACKAGING")!,
        northEvidence.id, northOfferContent,
      ),
      ensureOffer(
        client, input.orgId, input.caseId, budgetSupplier, input.contacts.get("BUDGET-BOX")!,
        budgetEvidence.id, budgetOfferContent,
      ),
    ]);
    const [bayQuote, northQuote] = await Promise.all([
      ensureQuote(client, {
        org_id: input.orgId,
        case_id: input.caseId,
        offer_id: bayOffer.id,
        supplier_id: baySupplier.id,
        contact_id: input.contacts.get("BAY-CARTON")!.id,
        item_id: input.item.id,
        quantity: 4000,
        unit: "carton",
        unit_price_minor: 35,
        currency: "USD",
        freight_minor: 7500,
        fees_minor: 0,
        nonrecoverable_tax_minor: 0,
        destination_location_id: input.location.id,
        arrival_start: HARBOR_PACK_TIMES.firstBridgeArrivalAt,
        arrival_end: HARBOR_PACK_TIMES.delayedArrivalAt,
        valid_until: HARBOR_PACK_TIMES.quoteValidUntil,
        latest_order_at: HARBOR_PACK_TIMES.quoteValidUntil,
        status: "verified",
        original_order_terms: {
          original_order_treatment: "split",
          original_commitment_minor: 140000,
          cancellation_minor: 0,
          confirmed_credit_minor: 0,
          specification_status: "match",
          schedule: [
            { quantity: 600, arrival_start: HARBOR_PACK_TIMES.firstBridgeArrivalAt, arrival_end: HARBOR_PACK_TIMES.firstBridgeArrivalAt },
            { quantity: 3400, arrival_start: HARBOR_PACK_TIMES.delayedArrivalAt, arrival_end: HARBOR_PACK_TIMES.delayedArrivalAt },
          ],
        },
        evidence_ids: [bayEvidence.id, specEvidence.id],
        verified_at: HARBOR_PACK_FIXTURE_CLOCK,
      }),
      ensureQuote(client, {
        org_id: input.orgId,
        case_id: input.caseId,
        offer_id: northOffer.id,
        supplier_id: northSupplier.id,
        contact_id: input.contacts.get("NORTH-PACKAGING")!.id,
        item_id: input.item.id,
        quantity: 600,
        unit: "carton",
        unit_price_minor: 42,
        currency: "USD",
        freight_minor: 6000,
        fees_minor: 0,
        nonrecoverable_tax_minor: 0,
        destination_location_id: input.location.id,
        arrival_start: HARBOR_PACK_TIMES.firstBridgeArrivalAt,
        arrival_end: HARBOR_PACK_TIMES.firstBridgeArrivalAt,
        valid_until: HARBOR_PACK_TIMES.quoteValidUntil,
        latest_order_at: HARBOR_PACK_TIMES.quoteValidUntil,
        status: "verified",
        original_order_terms: {
          original_order_treatment: "unchanged",
          cancellation_minor: 0,
          confirmed_credit_minor: 0,
          specification_status: "match",
          schedule: [
            { quantity: 600, arrival_start: HARBOR_PACK_TIMES.firstBridgeArrivalAt, arrival_end: HARBOR_PACK_TIMES.firstBridgeArrivalAt },
          ],
        },
        evidence_ids: [northEvidence.id, specEvidence.id],
        verified_at: HARBOR_PACK_FIXTURE_CLOCK,
      }),
      ensureQuote(client, {
        org_id: input.orgId,
        case_id: input.caseId,
        offer_id: budgetOffer.id,
        supplier_id: budgetSupplier.id,
        contact_id: input.contacts.get("BUDGET-BOX")!.id,
        item_id: input.alternativeItem.id,
        quantity: 600,
        unit: "carton",
        unit_price_minor: 25,
        currency: "USD",
        freight_minor: 1000,
        fees_minor: 0,
        nonrecoverable_tax_minor: 0,
        destination_location_id: input.location.id,
        arrival_start: HARBOR_PACK_TIMES.firstBridgeArrivalAt,
        arrival_end: HARBOR_PACK_TIMES.firstBridgeArrivalAt,
        valid_until: HARBOR_PACK_TIMES.quoteValidUntil,
        latest_order_at: HARBOR_PACK_TIMES.quoteValidUntil,
        status: "rejected",
        original_order_terms: {
          original_order_treatment: "unknown",
          specification_status: "mismatch",
          reasons: ["Dimensions 350 × 250 × 200 mm do not match required 300 × 200 × 150 mm"],
        },
        evidence_ids: [budgetEvidence.id, alternativeSpecEvidence.id],
        verified_at: HARBOR_PACK_FIXTURE_CLOCK,
      }),
    ]);
    const bayPlan = await ensurePlan(client, {
      orgId: input.orgId,
      caseId: input.caseId,
      assessmentId: assessment.id,
      version: 1,
      status: "ready",
      quote: bayQuote,
      supplier: baySupplier,
      evidenceIds: [bayEvidence.id, specEvidence.id],
      itemId: input.item.id,
      itemUnit: input.item.base_unit,
      locationId: input.location.id,
      quantity: 600,
      summary: "Split PO-1042: receive 600 cartons on October 14 and 3,400 cartons on October 16",
      grossMinor: 7500,
      incrementalMinor: 7500,
    });
    await ensurePlan(client, {
      orgId: input.orgId,
      caseId: input.caseId,
      assessmentId: assessment.id,
      version: 2,
      status: "draft",
      quote: northQuote,
      supplier: northSupplier,
      evidenceIds: [northEvidence.id, specEvidence.id],
      itemId: input.item.id,
      itemUnit: input.item.base_unit,
      locationId: input.location.id,
      quantity: 600,
      summary: "Purchase a 600-carton bridge from North Packaging; the original PO remains unchanged",
      grossMinor: 31200,
      incrementalMinor: 31200,
    });
    const { error: updateCaseError } = await client.from("cases").update({
      current_assessment_id: assessment.id,
      current_plan_id: bayPlan.id,
      next_check_at: HARBOR_PACK_TIMES.quoteValidUntil,
      updated_at: input.now.toISOString(),
    }).eq("org_id", input.orgId).eq("id", input.caseId);
    failDatabase(updateCaseError, "link canonical plan");
    const { error: actionError } = await client.from("actions").upsert({
      org_id: input.orgId,
      case_id: input.caseId,
      plan_id: bayPlan.id,
      kind: "supplier_email",
      state: "confirmed",
      payload_version: 1,
      payload_hash: createHash("sha256").update(`${input.caseId}:bay-carton-contact`).digest("hex"),
      payload: {
        mode: "replay",
        to: "alyssa@baycarton.example.com",
        summary: "Requested a split delivery; the supplier confirmed the revised schedule.",
        evidence_ids: [bayEvidence.id],
      },
      idempotency_key: `harbor-pack:${input.caseId}:bay-carton-contact`,
      provider: "replay-fixture",
      provider_ref: "harbor-pack:bay-carton-contact",
      permitted_by: null,
      attempts: 1,
      dispatch_started_at: HARBOR_PACK_FIXTURE_CLOCK,
      outcome: { result: "confirmed", mode: "replay" },
      mode: "replay",
    }, { onConflict: "org_id,idempotency_key" });
    failDatabase(actionError, "record replay action");
    const auditEvents = [
      {
        seed: "delay-received",
        at: "2026-10-12T15:00:00.000Z",
        eventName: "supplier.delay.received",
        title: "Bay Carton reported PO-1042 delayed to October 16",
        actorType: "system" as const,
        evidenceIds: [delayEvidence.id],
      },
      {
        seed: "order-matched",
        at: "2026-10-12T15:02:00.000Z",
        eventName: "purchase_order.line_matched",
        title: "Matched the delay notice to PO-1042 line 1",
        actorType: "agent" as const,
        evidenceIds: [delayEvidence.id],
      },
      {
        seed: "stock-recalculated",
        at: "2026-10-12T15:04:00.000Z",
        eventName: "assessment.recalculated",
        title: "Stock first runs short October 14 at 9:00 AM PDT",
        actorType: "system" as const,
        evidenceIds: [delayEvidence.id],
      },
      {
        seed: "request-sent",
        at: "2026-10-12T15:10:00.000Z",
        eventName: "supplier.request.sent",
        title: "A split delivery request was recorded in replay",
        actorType: "system" as const,
        evidenceIds: [bayEvidence.id],
      },
      {
        seed: "offer-verified",
        at: "2026-10-12T15:12:00.000Z",
        eventName: "supplier.offer.verified",
        title: "Bay Carton confirmed the split delivery and freight",
        actorType: "agent" as const,
        evidenceIds: [bayEvidence.id],
      },
      {
        seed: "plan-ready",
        at: "2026-10-12T15:14:00.000Z",
        eventName: "recovery.plan.ready",
        title: "Recovery plan is ready for owner approval",
        actorType: "system" as const,
        evidenceIds: [bayEvidence.id, specEvidence.id],
      },
    ];
    for (const event of auditEvents) {
      await ensureAuditEvent(client, {
        orgId: input.orgId,
        caseId: input.caseId,
        ...event,
      });
    }
  } else {
    const { error } = await client.from("cases").update({
      current_assessment_id: assessment.id,
      current_plan_id: null,
      next_check_at: null,
      updated_at: input.now.toISOString(),
    }).eq("org_id", input.orgId).eq("id", input.caseId);
    failDatabase(error, "link harmless assessment");
  }
  for (const eventEvidence of [delayEvidence]) {
    const link = await maybeOne(
      client,
      "case_evidence",
      (query) => query.eq("org_id", input.orgId)
        .eq("case_id", input.caseId)
        .eq("evidence_id", eventEvidence.id)
        .eq("purpose", "delay-source"),
    );
    if (!link) {
      await upsert(
        client,
        "case_evidence",
        {
          org_id: input.orgId,
          case_id: input.caseId,
          evidence_id: eventEvidence.id,
          purpose: "delay-source",
        },
        "org_id,case_id,evidence_id,purpose",
      );
    }
  }
}

export async function loadHarborPack(
  input: LoadHarborPackInput,
): Promise<LoadHarborPackResult> {
  if (!input.orgId) throw new QueryError("invalid_org", 422, "Organization is required");
  if (process.env.APP_ENV === "live") {
    throw new QueryError("demo_disabled", 409, "Demo data cannot be loaded in a live environment");
  }
  const client = input.client ?? (await import("@/lib/db/service")).createServiceClient();
  const organization = await maybeOne(
    client,
    "organizations",
    (query) => query.eq("id", input.orgId),
  );
  if (!organization) throw new QueryError("organization_not_found", 404, "Organization not found");
  if (organization.environment_mode === "live") {
    throw new QueryError("demo_disabled", 409, "Demo data cannot be loaded in a live organization");
  }
  const hash = await fixtureHash();
  const [fixtureRows, dataset] = await Promise.all([
    upsertFixtureRows(client, input.orgId),
    ensureDataset(client, input.orgId, input.fixtureId, hash, input.reset),
  ]);
  const definition = HARBOR_PACK_FIXTURES[input.fixtureId];
  const caseRow = await ensureCase(
    client,
    input.orgId,
    input.fixtureId,
    fixtureRows.item.id,
    fixtureRows.location.id,
    input.now,
    input.reset,
  );
  await ensureCaseOrderLine(client, input.orgId, caseRow.id, fixtureRows.poLine.id);
  await loadCanonicalData(client, {
    orgId: input.orgId,
    fixtureId: input.fixtureId,
    datasetId: dataset.id,
    caseId: caseRow.id,
    item: fixtureRows.item,
    alternativeItem: fixtureRows.alternativeItem,
    location: fixtureRows.location,
    suppliers: fixtureRows.suppliers,
    contacts: fixtureRows.contacts,
    poLine: fixtureRows.poLine,
    now: input.now,
    inventory: definition.startingInventory,
  });
  return {
    org_id: input.orgId,
    fixture_id: input.fixtureId,
    dataset_id: dataset.id,
    case_id: caseRow.id,
    phase: definition.phase,
    reset: input.reset,
    data_label: "Replay",
  };
}
