import { createServiceClient } from "@/lib/db/service";
import type { CaseListQuery } from "./contracts";
import {
  comparePriority,
  dataLabel,
  deriveSeverity,
  isDataStale,
  nextAction,
  orderOptions,
  priorityRank,
  shortageLabel,
  type CasePhase,
  type MembershipRole,
  type OptionForOrdering,
  type PriorityInput,
  type Severity,
} from "./derive";
import { formatDateTime, formatQuantity } from "./format";
import { QueryError, type QueryContext, queryClient } from "./client";
import type { SupabaseClient } from "@supabase/supabase-js";

// PostgREST table names are dynamic in this projection layer.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export interface CaseSummary {
  id: string;
  row_version: number;
  title: string;
  item: {
    id: string;
    sku: string;
    description: string;
    unit: string;
    specification: Record<string, unknown> | null;
  };
  location: { id: string; name: string; timezone: string };
  suppliers: { id: string; name: string }[];
  purchase_orders: string[];
  phase: CasePhase;
  run_control: "active" | "paused" | "blocked";
  block_reason: string | null;
  severity: Severity;
  first_shortage_at: string | null;
  shortage_label: string | null;
  bridge_quantity: number | null;
  next_action: { label: string; due_at: string | null; kind: string };
  assignee: { user_id: string; email: string | null } | null;
  source_as_of: string | null;
  data_stale: boolean;
  last_business_update_at: string;
  data_label: "Replay" | "Imported" | "Live" | null;
  has_uncertain_action: boolean;
  closed_outcome: string | null;
  priority_rank: number;
}

export interface ProjectionPoint {
  kind: "start" | "receipt" | "demand";
  at: string;
  delta: number;
  balance: number;
  sourceId: string | null;
  label: string;
}

export interface ApprovalView {
  plan_id: string;
  plan_version: number;
  status: string;
  row_version: number;
  input_fingerprint: string;
  gross_commitment_minor: string | null;
  incremental_cost_minor: string | null;
  currency: string;
  approved_ceiling_minor: string | null;
  expires_at: string | null;
  dependencies: string[];
  steps: {
    step_id: string;
    kind: string;
    quantity: number | null;
    unit: string;
    summary: string;
    execution_mode: string;
  }[];
  supplier: { id: string; name: string } | null;
  evidence_ids: string[];
  approver_required: "owner";
}

export interface CaseDetail {
  case: CaseSummary & {
    episode: number;
    closed_reason: string | null;
    created_at: string;
    updated_at: string;
  };
  impact_sentence: string;
  explanation: string;
  assessment: {
    id: string;
    version: number;
    quality: "sufficient" | "insufficient";
    unit: string;
    first_shortage_at: string | null;
    bridge_quantity: number | null;
    requirements: { by: string; cumulative_quantity: number }[];
    horizon_start: string | null;
    horizon_end: string | null;
    source_as_of: string | null;
    assessed_at: string;
    input_fingerprint: string;
    missing_facts: string[];
    points: ProjectionPoint[];
  } | null;
  order_lines: {
    po_line_id: string;
    po: string;
    line: string;
    ordered_qty: number;
    received_qty: number;
    affected_qty: number;
    original_due_at: string | null;
    revised_receipts: {
      id: string;
      quantity: number;
      earliest_at: string | null;
      latest_at: string | null;
      promise_state: string;
    }[];
  }[];
  plan: ApprovalView | null;
  permissions: {
    can_control: boolean;
    can_approve: boolean;
    can_reassess: boolean;
    can_accept_risk: boolean;
    can_correct_quote: boolean;
  };
  data_label: "Replay" | "Imported" | "Live" | null;
}

export interface OptionRow extends OptionForOrdering {
  plan_id: string | null;
  quote_id: string;
  supplier: { id: string; name: string; purchasing_status: string };
  location: string | null;
  item_sku: string;
  specification_status: "match" | "mismatch" | "unverified";
  quantity: number | null;
  schedule: { quantity: number; arrival_start: string | null; arrival_end: string | null }[];
  costs: {
    item_cost_minor: string | null;
    freight_minor: string | null;
    fees_minor: string | null;
    nonrecoverable_tax_minor: string | null;
    cancellation_minor: string | null;
    credits_minor: string | null;
    total_cash_outlay_minor: string | null;
    net_incremental_minor: string | null;
  };
  currency: string | null;
  valid_until: string | null;
  latest_order_at: string | null;
  written_confirmation: boolean;
  quote_status: string;
  original_order_treatment: string;
  reasons: string[];
  missing_fields: string[];
  evidence_ids: string[];
  last_verified_at: string | null;
  surplus_quantity: number | null;
}

export interface CaseEvidence {
  id: string;
  source_type: string;
  locator: string | null;
  supported_excerpt: string | null;
  source_time: string | null;
  captured_at: string;
  has_file: boolean;
  verified_at: string | null;
  purpose: string;
}

export interface TimelineEntry {
  id: string;
  at: string;
  group:
    | "received_delay"
    | "matched_order"
    | "recalculated_stock"
    | "request_sent"
    | "call_outcome"
    | "offer_verified"
    | "approval"
    | "execution"
    | "receipt"
    | "control";
  title: string;
  actor: { type: string; label: string };
  status: "intended" | "submitted" | "confirmed" | "failed" | "unknown" | "info";
  action_ref: string | null;
  evidence_ids: string[];
}

export interface CaseListResult {
  items: CaseSummary[];
  next_cursor: string | null;
  total_matching: number;
  counts: { by_phase: Record<CasePhase, number> };
  summary: {
    active_shortages: number;
    decisions_waiting: number;
    uncertain_actions: number;
    recoveries_recorded: number;
    active_cases: number;
  };
  refreshed_at: string;
}

interface CaseData {
  cases: Row[];
  items: Map<string, Row>;
  locations: Map<string, Row>;
  assessments: Map<string, Row>;
  datasets: Map<string, Row>;
  suppliers: Map<string, Row>;
  purchaseOrders: Map<string, Row>;
  poLines: Map<string, Row>;
  caseOrderLines: Row[];
  actions: Row[];
  plans: Map<string, Row>;
  organizations: Row;
  memberEmails: Map<string, string>;
}

const allPhases: CasePhase[] = [
  "new",
  "needs_review",
  "assessing",
  "recovering",
  "awaiting_supplier",
  "awaiting_approval",
  "executing",
  "monitoring",
  "closed",
];

function checkError(error: { message: string; code?: string } | null): void {
  if (error) {
    throw new QueryError("query_failed", 503, "The requested data is temporarily unavailable");
  }
}

async function selectRows(
  query: PromiseLike<{ data: Row[] | null; error: { message: string; code?: string } | null }>,
): Promise<Row[]> {
  const result = await query;
  checkError(result.error);
  return result.data ?? [];
}

async function getRowsByIds(
  client: SupabaseClient,
  table: string,
  orgId: string,
  ids: string[],
): Promise<Row[]> {
  if (ids.length === 0) return [];
  return selectRows(
    client.from(table).select("*").eq("org_id", orgId).in("id", [...new Set(ids)]),
  );
}

async function loadCaseData(context: QueryContext, caseId?: string): Promise<CaseData> {
  const client = await queryClient(context);
  let caseQuery = client.from("cases").select("*").eq("org_id", context.orgId);
  if (caseId) caseQuery = caseQuery.eq("id", caseId);
  const caseRows = await selectRows(caseQuery.order("updated_at", { ascending: false }).limit(1000));
  if (caseId && caseRows.length === 0) {
    throw new QueryError("case_not_found", 404, "Case not found");
  }

  const itemIds = [...new Set(caseRows.map((row) => row.item_id))];
  const locationIds = [...new Set(caseRows.map((row) => row.location_id))];
  const assessmentIds = [...new Set(caseRows.map((row) => row.current_assessment_id).filter(Boolean))];
  const planIds = [...new Set(caseRows.map((row) => row.current_plan_id).filter(Boolean))];
  const [items, locations, assessments, plans, organizations, caseOrderLines, actions] =
    await Promise.all([
      getRowsByIds(client, "items", context.orgId, itemIds),
      getRowsByIds(client, "locations", context.orgId, locationIds),
      getRowsByIds(client, "assessments", context.orgId, assessmentIds),
      getRowsByIds(client, "recovery_plans", context.orgId, planIds),
      selectRows(
        client.from("organizations").select("id,environment_mode,currency,timezone")
          .eq("id", context.orgId).limit(1),
      ),
      caseRows.length
        ? selectRows(
            client.from("case_order_lines").select("*")
              .eq("org_id", context.orgId)
              .in("case_id", caseRows.map((row) => row.id)),
          )
        : Promise.resolve([]),
      caseRows.length
        ? selectRows(
            client.from("actions").select("id,case_id,state,created_at,payload")
              .eq("org_id", context.orgId)
              .in("case_id", caseRows.map((row) => row.id)),
          )
        : Promise.resolve([]),
    ]);
  const datasetIds = [...new Set(assessments.map((row) => row.source_versions?.dataset_id).filter(Boolean))];
  const poLineIds = [...new Set(caseOrderLines.map((row) => row.po_line_id))];
  const [datasets, poLines] = await Promise.all([
    getRowsByIds(client, "datasets", context.orgId, datasetIds),
    getRowsByIds(client, "purchase_order_lines", context.orgId, poLineIds),
  ]);
  const poIds = [...new Set(poLines.map((row) => row.purchase_order_id))];
  const purchaseOrders = await getRowsByIds(client, "purchase_orders", context.orgId, poIds);
  const supplierIds = [...new Set(purchaseOrders.map((row) => row.supplier_id))];
  const suppliers = await getRowsByIds(client, "suppliers", context.orgId, supplierIds);
  const assignedUserIds = [...new Set(caseRows.map((row) => row.assignee_user_id).filter(Boolean))];
  const memberEmails = new Map<string, string>();
  if (assignedUserIds.length > 0) {
    const serviceClient = createServiceClient();
    const results = await Promise.all(
      assignedUserIds.map(async (userId) => {
        const { data } = await serviceClient.auth.admin.getUserById(userId);
        if (data.user?.email) memberEmails.set(userId, data.user.email);
      }),
    );
    void results;
  }

  return {
    cases: caseRows,
    items: new Map(items.map((row) => [row.id, row])),
    locations: new Map(locations.map((row) => [row.id, row])),
    assessments: new Map(assessments.map((row) => [row.id, row])),
    datasets: new Map(datasets.map((row) => [row.id, row])),
    suppliers: new Map(suppliers.map((row) => [row.id, row])),
    purchaseOrders: new Map(purchaseOrders.map((row) => [row.id, row])),
    poLines: new Map(poLines.map((row) => [row.id, row])),
    caseOrderLines,
    actions,
    plans: new Map(plans.map((row) => [row.id, row])),
    organizations: organizations[0] ?? { environment_mode: "replay", currency: "USD", timezone: "UTC" },
    memberEmails,
  };
}

function summarize(row: Row, data: CaseData, role: MembershipRole, now: Date): CaseSummary {
  const item = data.items.get(row.item_id) ?? {};
  const location = data.locations.get(row.location_id) ?? {};
  const assessment = data.assessments.get(row.current_assessment_id) ?? null;
  const dataset = assessment
    ? data.datasets.get(assessment.source_versions?.dataset_id) ?? null
    : null;
  const uncertain = data.actions.some(
    (action) =>
      action.case_id === row.id &&
      ["unknown", "dispatching", "submitted"].includes(action.state),
  );
  const linkedLines = data.caseOrderLines.filter((link) => link.case_id === row.id);
  const purchaseOrders = new Set<string>();
  const supplierRows = new Map<string, { id: string; name: string }>();
  for (const link of linkedLines) {
    const line = data.poLines.get(link.po_line_id);
    const order = line ? data.purchaseOrders.get(line.purchase_order_id) : null;
    const supplier = order ? data.suppliers.get(order.supplier_id) : null;
    if (order?.external_id) purchaseOrders.add(order.external_id);
    if (supplier?.id) supplierRows.set(supplier.id, { id: supplier.id, name: supplier.name });
  }
  const dueAt = row.next_check_at ?? null;
  const shortageAt = assessment?.first_shortage_at ?? null;
  const quality = assessment?.quality ?? null;
  const phase = row.phase as CasePhase;
  const runControl = row.run_control as "active" | "paused" | "blocked";
  const derivedRank = priorityRank(
    {
      id: row.id,
      phase,
      run_control: runControl,
      block_reason: row.block_reason,
      has_uncertain_action: uncertain,
      first_shortage_at: shortageAt,
      next_check_at: dueAt,
      updated_at: row.updated_at,
    },
    now,
  );
  const sourceAsOf = dataset?.source_as_of ?? null;
  const dataSourceType = dataset?.source_type ?? null;
  const sourceVersions = assessment?.source_versions ?? null;
  const severity = deriveSeverity(quality, shortageAt, now);
  const labels = dataLabel(sourceVersions, dataSourceType);
  const supplierIds = [...supplierRows.values()];
  return {
    id: row.id,
    row_version: row.row_version,
    title: `${item.sku ?? "Unknown item"}${purchaseOrders.size ? ` · ${[...purchaseOrders].join(", ")}` : ""}`,
    item: {
      id: row.item_id,
      sku: item.sku ?? "",
      description: item.description ?? "",
      unit: item.base_unit ?? "unit",
      specification: item.specification ?? null,
    },
    location: {
      id: row.location_id,
      name: location.name ?? "",
      timezone: location.timezone ?? data.organizations.timezone ?? "UTC",
    },
    suppliers: supplierIds,
    purchase_orders: [...purchaseOrders].sort(),
    phase,
    run_control: runControl,
    block_reason: row.block_reason ?? null,
    severity,
    first_shortage_at: shortageAt,
    shortage_label: shortageLabel(quality, shortageAt),
    bridge_quantity: assessment?.bridge_qty ?? null,
    next_action: nextAction(phase, runControl, row.block_reason, role, {
      outcome: row.closed_outcome,
      dueAt,
    }),
    assignee: row.assignee_user_id
      ? {
          user_id: row.assignee_user_id,
          email: data.memberEmails.get(row.assignee_user_id) ?? null,
        }
      : null,
    source_as_of: sourceAsOf,
    data_stale: isDataStale(sourceAsOf, data.organizations.environment_mode, now),
    last_business_update_at: row.updated_at,
    data_label: labels,
    has_uncertain_action: uncertain,
    closed_outcome: row.closed_outcome ?? null,
    priority_rank: derivedRank,
  };
}

function encodeCursor(value: {
  rank: number;
  shortage: string | null;
  updated: string;
  id: string;
}): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeCursor(cursor: string): { rank: number; shortage: string | null; updated: string; id: string } {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const cursorValue = decoded as Record<string, unknown>;
    if (
      typeof decoded === "object" &&
      decoded !== null &&
      typeof cursorValue.rank === "number" &&
      (cursorValue.shortage === null || typeof cursorValue.shortage === "string") &&
      typeof cursorValue.updated === "string" &&
      typeof cursorValue.id === "string"
    ) {
      return decoded as { rank: number; shortage: string | null; updated: string; id: string };
    }
  } catch {
    // Invalid cursors are handled as a safe client error below.
  }
  throw new QueryError("invalid_cursor", 422, "Case cursor is invalid");
}

function cursorAfter(
  row: CaseSummary,
  rowData: Row,
  cursor: { rank: number; shortage: string | null; updated: string; id: string },
): boolean {
  if (row.priority_rank !== cursor.rank) return row.priority_rank > cursor.rank;
  const rowShortage = row.first_shortage_at ? new Date(row.first_shortage_at).getTime() : Infinity;
  const cursorShortage = cursor.shortage ? new Date(cursor.shortage).getTime() : Infinity;
  if (rowShortage !== cursorShortage) return rowShortage > cursorShortage;
  const rowUpdated = new Date(rowData.updated_at).getTime();
  const cursorUpdated = new Date(cursor.updated).getTime();
  if (rowUpdated !== cursorUpdated) return rowUpdated < cursorUpdated;
  return row.id.localeCompare(cursor.id) > 0;
}

function filtered(
  summary: CaseSummary,
  row: Row,
  context: QueryContext,
  filters: CaseListQuery,
  includePhase: boolean,
  includeClosed: boolean,
  searchText: string,
): boolean {
  if (!includeClosed && summary.phase === "closed") return false;
  if (includePhase && filters.phase?.length && !filters.phase.includes(summary.phase)) return false;
  if (filters.severity?.length && !filters.severity.includes(summary.severity)) return false;
  if (filters.assignee === "me" && row.assignee_user_id !== context.userId) return false;
  if (filters.assignee === "unassigned" && row.assignee_user_id !== null) return false;
  if (filters.assignee && filters.assignee !== "me" && filters.assignee !== "unassigned" &&
    row.assignee_user_id !== filters.assignee) return false;
  if (filters.item && row.item_id !== filters.item) return false;
  if (
    filters.supplier &&
    !summary.suppliers.some((supplier) => supplier.id === filters.supplier)
  ) return false;
  if (filters.needs_my_decision) {
    const needed =
      context.role === "owner"
        ? ["awaiting_approval", "needs_review"].includes(summary.phase)
        : context.role === "operator" && summary.phase === "needs_review";
    if (!needed) return false;
  }
  if (filters.data_stale !== undefined && summary.data_stale !== filters.data_stale) return false;
  if (
    filters.uncertain_action !== undefined &&
    summary.has_uncertain_action !== filters.uncertain_action
  ) return false;
  if (filters.closed_outcome && row.closed_outcome !== filters.closed_outcome) return false;
  if (searchText) {
    const searchable = [
      summary.id,
      ...summary.purchase_orders,
      summary.item.sku,
      summary.item.description,
      ...summary.suppliers.map((supplier) => supplier.name),
    ].join(" ").toLocaleLowerCase();
    if (!searchable.includes(searchText)) return false;
  }
  return true;
}

function priorityInput(
  summary: CaseSummary,
  row: Row,
): PriorityInput & { priority_rank: number } {
  return {
    id: summary.id,
    phase: summary.phase,
    run_control: summary.run_control,
    block_reason: summary.block_reason,
    has_uncertain_action: summary.has_uncertain_action,
    first_shortage_at: summary.first_shortage_at,
    next_check_at: row.next_check_at,
    updated_at: row.updated_at,
    priority_rank: summary.priority_rank,
  };
}

export async function listCases(
  context: QueryContext,
  filters: CaseListQuery,
  now: Date,
): Promise<CaseListResult> {
  const data = await loadCaseData(context);
  const mapped = data.cases.map((row) => ({
    row,
    summary: summarize(row, data, context.role, now),
  }));
  const searchText = filters.q?.toLocaleLowerCase() ?? "";
  const includeClosed =
    filters.include_closed ?? Boolean(filters.phase?.includes("closed") || filters.closed_outcome);
  const base = mapped.filter(({ summary, row }) =>
    filtered(summary, row, context, filters, false, includeClosed, searchText),
  );
  const allFiltered = mapped.filter(({ summary, row }) =>
    filtered(summary, row, context, filters, true, includeClosed, searchText),
  );
  allFiltered.sort((left, right) =>
    comparePriority(priorityInput(left.summary, left.row), priorityInput(right.summary, right.row)),
  );

  const totalMatching = allFiltered.length;
  let page = allFiltered;
  if (filters.cursor) {
    const cursor = decodeCursor(filters.cursor);
    page = page.filter(({ summary, row }) => cursorAfter(summary, row, cursor));
  }
  page = page.slice(0, filters.limit);
  const hasMore = page.length > 0 &&
    allFiltered.some(({ summary, row }) => cursorAfter(summary, row, {
      rank: page[page.length - 1].summary.priority_rank,
      shortage: page[page.length - 1].summary.first_shortage_at,
      updated: page[page.length - 1].row.updated_at,
      id: page[page.length - 1].summary.id,
    }));
  const last = page.at(-1);
  const byPhase = Object.fromEntries(
    allPhases.map((phase) => [
      phase,
      base.filter(({ summary }) => summary.phase === phase).length,
    ]),
  ) as Record<CasePhase, number>;
  const summary = {
    active_shortages: base.filter(
      ({ summary: item }) => item.phase !== "closed" && item.first_shortage_at !== null,
    ).length,
    decisions_waiting: base.filter(({ summary: item }) => item.phase === "awaiting_approval").length,
    uncertain_actions: base.filter(({ summary: item }) => item.has_uncertain_action).length,
    recoveries_recorded: base.filter(({ summary: item }) =>
      ["monitoring", "closed"].includes(item.phase),
    ).length,
    active_cases: base.filter(({ summary: item }) => item.phase !== "closed").length,
  };

  return {
    items: page.map(({ summary: item }) => item),
    next_cursor: hasMore && last
      ? encodeCursor({
          rank: last.summary.priority_rank,
          shortage: last.summary.first_shortage_at,
          updated: last.row.updated_at,
          id: last.summary.id,
        })
      : null,
    total_matching: totalMatching,
    counts: { by_phase: byPhase },
    summary,
    refreshed_at: now.toISOString(),
  };
}

async function singleCaseData(context: QueryContext, caseId: string): Promise<{
  row: Row;
  data: CaseData;
  assessment: Row | null;
  plan: Row | null;
  client: SupabaseClient;
}> {
  const data = await loadCaseData(context, caseId);
  const row = data.cases[0];
  const client = await queryClient(context);
  return {
    row,
    data,
    assessment: data.assessments.get(row.current_assessment_id) ?? null,
    plan: data.plans.get(row.current_plan_id) ?? null,
    client,
  };
}

export async function getCaseDetail(
  context: QueryContext,
  caseId: string,
  now: Date,
): Promise<CaseDetail> {
  const base = await singleCaseData(context, caseId);
  const summary = summarize(base.row, base.data, context.role, now);
  const row = base.row;
  const assessment = base.assessment;
  const dataSet = assessment
    ? base.data.datasets.get(assessment.source_versions?.dataset_id) ?? null
    : null;
  const item = base.data.items.get(row.item_id) ?? {};
  const location = base.data.locations.get(row.location_id) ?? {};
  let assessmentView: CaseDetail["assessment"] = null;
  if (assessment) {
    const projection: Row[] = Array.isArray(assessment.projection)
      ? assessment.projection
      : Array.isArray(assessment.projection?.points)
        ? assessment.projection.points
        : [];
    assessmentView = {
      id: assessment.id,
      version: assessment.version,
      quality: assessment.quality,
      unit: item.base_unit ?? "unit",
      first_shortage_at: assessment.first_shortage_at,
      bridge_quantity: assessment.bridge_qty,
      requirements: (assessment.dated_requirements ?? []).map((requirement: Row) => ({
        by: requirement.by,
        cumulative_quantity:
          requirement.cumulative_quantity ?? requirement.cumulative_qty ?? requirement.quantity,
      })),
      horizon_start: assessment.horizon_start,
      horizon_end: assessment.horizon_end,
      source_as_of: dataSet?.source_as_of ?? null,
      assessed_at: assessment.created_at,
      input_fingerprint: assessment.input_fingerprint,
      missing_facts: Array.isArray(assessment.projection?.missing_facts)
        ? assessment.projection.missing_facts
        : [],
      points: projection.map((point) => ({
        kind: point.kind,
        at: point.at ?? point.time,
        delta: point.delta,
        balance: point.balance,
        sourceId: point.sourceId ?? point.source_id ?? null,
        label: point.label ?? "",
      })),
    };
  }

  const caseOrderLinks = base.data.caseOrderLines.filter((link) => link.case_id === caseId);
  const poLineIds = caseOrderLinks.map((link) => link.po_line_id);
  const schedules = poLineIds.length
    ? await selectRows(
        base.client.from("receipt_schedules").select("*")
          .eq("org_id", context.orgId)
          .in("po_line_id", poLineIds),
      )
    : [];
  const orderLines = caseOrderLinks.flatMap((link) => {
    const poLine = base.data.poLines.get(link.po_line_id);
    if (!poLine) return [];
    const order = base.data.purchaseOrders.get(poLine.purchase_order_id);
    return [{
      po_line_id: poLine.id,
      po: order?.external_id ?? "",
      line: poLine.external_line_id ?? "",
      ordered_qty: poLine.ordered_qty,
      received_qty: poLine.received_qty,
      affected_qty: link.affected_qty,
      original_due_at: poLine.original_due_at,
      revised_receipts: schedules
        .filter((schedule) => schedule.po_line_id === poLine.id && schedule.promise_state !== "superseded")
        .map((schedule) => ({
          id: schedule.id,
          quantity: schedule.quantity_remaining,
          earliest_at: schedule.earliest_at,
          latest_at: schedule.latest_at,
          promise_state: schedule.promise_state,
        })),
    }];
  });

  let planView: ApprovalView | null = null;
  const plan = base.plan;
  if (plan) {
    const planSteps = await selectRows(
      base.client.from("plan_steps").select("*")
        .eq("org_id", context.orgId)
        .eq("plan_id", plan.id),
    );
    const quoteRows = await selectRows(
      base.client.from("quotes").select("*")
        .eq("org_id", context.orgId)
        .eq("case_id", caseId),
    );
    const quote = quoteRows.find((candidate) =>
      (plan.dependencies ?? []).some((dependency: Row) =>
        dependency.quote_id === candidate.id || dependency.quoteId === candidate.id,
      ),
    ) ?? quoteRows[0];
    const supplier = quote ? base.data.suppliers.get(quote.supplier_id) : null;
    planView = {
      plan_id: plan.id,
      plan_version: plan.version,
      status: plan.status,
      row_version: plan.row_version,
      input_fingerprint: plan.input_fingerprint,
      gross_commitment_minor:
        plan.gross_commitment_minor === null ? null : String(plan.gross_commitment_minor),
      incremental_cost_minor:
        plan.incremental_cost_minor === null ? null : String(plan.incremental_cost_minor),
      currency: quote?.currency ?? base.data.organizations.currency,
      approved_ceiling_minor:
        plan.gross_commitment_minor === null ? null : String(plan.gross_commitment_minor),
      expires_at: plan.expires_at,
      dependencies: Array.isArray(plan.dependencies)
        ? plan.dependencies.map((dependency: Row) => String(dependency.description ?? dependency.kind ?? ""))
        : [],
      steps: planSteps.map((step) => ({
        step_id: step.step_id,
        kind: step.kind,
        quantity: step.quantity,
        unit: step.unit,
        summary: String(step.payload?.summary ?? step.kind),
        execution_mode: step.execution_mode,
      })),
      supplier: supplier ? { id: supplier.id, name: supplier.name } : null,
      evidence_ids: [...new Set([
        ...(plan.evidence_ids ?? []),
        ...(quote?.evidence_ids ?? []),
        ...planSteps.flatMap((step) => step.evidence_ids ?? []),
      ])],
      approver_required: "owner",
    };
  }

  const timezone = location.timezone ?? base.data.organizations.timezone ?? "UTC";
  const bridgeText = formatQuantity(assessment?.bridge_qty ?? null, item.base_unit ?? "unit");
  const firstShortage = formatDateTime(assessment?.first_shortage_at ?? null, timezone);
  const impactSentence =
    assessment?.quality === "sufficient" && assessment.first_shortage_at && bridgeText && firstShortage
      ? `${bridgeText} are needed before the delayed shipment arrives; stock first runs short ${firstShortage}.`
      : summary.shortage_label ?? "The current impact needs more information.";
  return {
    case: {
      ...summary,
      episode: row.episode,
      closed_reason: row.closed_reason,
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
    impact_sentence: impactSentence,
    explanation:
      assessment?.quality === "sufficient"
        ? "The assessment uses the latest available inventory, demand, and expected-receipt evidence."
        : "The impact cannot be confirmed until the missing business facts are resolved.",
    assessment: assessmentView,
    order_lines: orderLines,
    plan: planView,
    permissions: {
      can_control: context.role === "owner" || context.role === "operator",
      can_approve: context.role === "owner" && row.phase === "awaiting_approval",
      can_reassess: context.role === "owner" || context.role === "operator",
      can_accept_risk: context.role === "owner",
      can_correct_quote: context.role === "owner" || context.role === "operator",
    },
    data_label: summary.data_label,
  };
}

export async function getCaseOptions(
  context: QueryContext,
  caseId: string,
): Promise<{ options: OptionRow[] }> {
  const base = await singleCaseData(context, caseId);
  const quoteRows = await selectRows(
    base.client.from("quotes").select("*")
      .eq("org_id", context.orgId)
      .eq("case_id", caseId),
  );
  if (quoteRows.length === 0) return { options: [] };
  const supplierIds = [...new Set(quoteRows.map((quote) => quote.supplier_id))];
  const itemIds = [...new Set(quoteRows.map((quote) => quote.item_id))];
  const locationIds = [...new Set(quoteRows.map((quote) => quote.destination_location_id).filter(Boolean))];
  const [supplierRows, items, locations, plans, supplierItems] = await Promise.all([
    getRowsByIds(base.client, "suppliers", context.orgId, supplierIds),
    getRowsByIds(base.client, "items", context.orgId, itemIds),
    getRowsByIds(base.client, "locations", context.orgId, locationIds),
    selectRows(
      base.client.from("recovery_plans").select("*")
        .eq("org_id", context.orgId).eq("case_id", caseId),
    ),
    selectRows(
      base.client.from("supplier_items").select("*")
        .eq("org_id", context.orgId)
        .in("supplier_id", supplierIds)
        .in("item_id", itemIds),
    ),
  ]);
  const evidenceIdsNeeded = [
    ...new Set([
      ...quoteRows.flatMap((quote) => quote.evidence_ids ?? []),
      ...supplierItems.map((entry) => entry.verified_specification_evidence_id).filter(Boolean),
      ...quoteRows
        .map((quote) => quote.original_order_terms?.specification_evidence_id)
        .filter(Boolean),
    ]),
  ];
  const evidence = evidenceIdsNeeded.length
    ? await selectRows(
        base.client.from("evidence").select("id,source_type,verified_at")
          .eq("org_id", context.orgId).in("id", evidenceIdsNeeded),
      )
    : [];
  const suppliers = new Map(supplierRows.map((row) => [row.id, row]));
  const itemMap = new Map(items.map((row) => [row.id, row]));
  const locationMap = new Map(locations.map((row) => [row.id, row]));
  const evidenceMap = new Map(evidence.map((row) => [row.id, row]));
  const supplierItemMap = new Map(
    supplierItems.map((entry) => [`${entry.supplier_id}:${entry.item_id}`, entry]),
  );

  const options = quoteRows.map((quote): OptionRow => {
    const supplier = suppliers.get(quote.supplier_id) ?? {};
    const item = itemMap.get(quote.item_id) ?? {};
    const location = locationMap.get(quote.destination_location_id) ?? {};
    const terms = quote.original_order_terms ?? {};
    const supplierItem = supplierItemMap.get(`${quote.supplier_id}:${quote.item_id}`);
    const specificationEvidenceId =
      supplierItem?.verified_specification_evidence_id ?? terms.specification_evidence_id;
    const specificationEvidence = specificationEvidenceId
      ? evidenceMap.get(specificationEvidenceId)
      : null;
    const schedule = Array.isArray(terms.schedule)
      ? terms.schedule.map((entry: Row) => ({
          quantity: Number(entry.quantity),
          arrival_start: entry.arrival_start ?? entry.earliest_at ?? null,
          arrival_end: entry.arrival_end ?? entry.latest_at ?? null,
        }))
      : [
          {
            quantity: quote.quantity ?? 0,
            arrival_start: quote.arrival_start,
            arrival_end: quote.arrival_end,
          },
        ];
    const evidenceIds: string[] = quote.evidence_ids ?? [];
    const evidenceRows = evidenceIds
      .map((id) => evidenceMap.get(id))
      .filter((entry): entry is Row => entry !== undefined);
    const specStatus =
      terms.specification_status === "mismatch" ||
      terms.specification_match === false ||
      quote.item_id !== base.row.item_id
        ? "mismatch"
        : Boolean(specificationEvidence?.verified_at) ||
            awaitedSpecVerified(terms, item)
          ? "match"
          : "unverified";
    const writtenConfirmation = evidenceRows.some(
      (entry) => entry.source_type === "email" && entry.verified_at,
    );
    const itemCost =
      quote.quantity !== null && quote.unit_price_minor !== null
        ? BigInt(quote.quantity) * BigInt(quote.unit_price_minor)
        : null;
    const freight = quote.freight_minor === null ? null : BigInt(quote.freight_minor);
    const fees = quote.fees_minor === null ? null : BigInt(quote.fees_minor);
    const tax =
      quote.nonrecoverable_tax_minor === null ? null : BigInt(quote.nonrecoverable_tax_minor);
    const cancellation =
      terms.cancellation_minor === undefined || terms.cancellation_minor === null
        ? null
        : BigInt(terms.cancellation_minor);
    const credits =
      terms.confirmed_credit_minor === undefined || terms.confirmed_credit_minor === null
        ? null
        : BigInt(terms.confirmed_credit_minor);
    const total =
      itemCost !== null && freight !== null && fees !== null && tax !== null
        ? itemCost + freight + fees + tax
        : null;
    const offset = terms.original_order_treatment === "split"
      ? BigInt(terms.original_commitment_minor ?? 0)
      : 0n;
    const net =
      total !== null && (cancellation !== null || terms.cancellation_minor === 0) &&
      (credits !== null || terms.confirmed_credit_minor === 0) &&
      terms.original_order_treatment
        ? total + (cancellation ?? 0n) - (credits ?? 0n) - offset
        : null;
    const missingFields: string[] = Array.isArray(terms.missing_fields) ? terms.missing_fields : [];
    if (quote.quantity === null) missingFields.push("quantity");
    if (quote.unit_price_minor === null) missingFields.push("unit_price");
    if (quote.currency === null) missingFields.push("currency");
    if (quote.freight_minor === null) missingFields.push("freight");
    if (quote.fees_minor === null) missingFields.push("fees");
    if (quote.nonrecoverable_tax_minor === null) missingFields.push("nonrecoverable_tax");
    if (schedule.some((entry: Row) => entry.arrival_start === null)) missingFields.push("arrival_window");
    if (!quote.verified_at) missingFields.push("verification");
    const optionPlans = plans.filter((plan) =>
      (plan.dependencies ?? []).some((dependency: Row) =>
        dependency.quote_id === quote.id || dependency.quoteId === quote.id,
      ),
    );
    const plan = optionPlans[0] ?? null;
    const termsReason = Array.isArray(terms.reasons) ? terms.reasons : [];
    const noSpecMatch = specStatus === "mismatch";
    return {
      id: quote.id,
      supplier_status: supplier.purchasing_status ?? "candidate",
      plan_id: plan?.id ?? null,
      quote_id: quote.id,
      supplier: {
        id: supplier.id ?? quote.supplier_id,
        name: supplier.name ?? "",
        purchasing_status: supplier.purchasing_status ?? "candidate",
      },
      location: location.name ?? null,
      item_sku: item.sku ?? "",
      specification_status: specStatus,
      quantity: quote.quantity,
      schedule,
      costs: {
        item_cost_minor: itemCost?.toString() ?? null,
        freight_minor: freight?.toString() ?? null,
        fees_minor: fees?.toString() ?? null,
        nonrecoverable_tax_minor: tax?.toString() ?? null,
        cancellation_minor: cancellation?.toString() ?? null,
        credits_minor: credits?.toString() ?? null,
        total_cash_outlay_minor: total?.toString() ?? null,
        net_incremental_minor: net?.toString() ?? null,
      },
      currency: quote.currency,
      valid_until: quote.valid_until,
      latest_order_at: quote.latest_order_at,
      written_confirmation: writtenConfirmation,
      quote_status: quote.status,
      original_order_treatment: terms.original_order_treatment ?? "unknown",
      feasibility: "incomplete",
      reasons: noSpecMatch ? [...termsReason, "The quoted dimensions do not match the required specification"] : termsReason,
      missing_fields: [...new Set(missingFields)],
      evidence_ids: evidenceIds,
      last_verified_at: quote.verified_at,
      surplus_quantity:
        terms.original_order_treatment === "unchanged" ? (quote.quantity ?? null) : null,
    } as OptionRow;
  });
  return { options: orderOptions(options) };
}

function awaitedSpecVerified(terms: Row, item: Row): boolean {
  return Boolean(
    terms.verified_specification === true &&
    terms.specification && item.specification &&
      JSON.stringify(terms.specification) === JSON.stringify(item.specification),
  );
}

export async function getCaseEvidence(
  context: QueryContext,
  caseId: string,
): Promise<CaseEvidence[]> {
  const { client } = await singleCaseData(context, caseId);
  const links = await selectRows(
    client.from("case_evidence").select("*")
      .eq("org_id", context.orgId)
      .eq("case_id", caseId),
  );
  if (links.length === 0) return [];
  const evidenceIds = [...new Set(links.map((link) => link.evidence_id))];
  const evidence = await selectRows(
    client.from("evidence").select("*")
      .eq("org_id", context.orgId)
      .in("id", evidenceIds),
  );
  const evidenceMap = new Map(evidence.map((row) => [row.id, row]));
  return links.flatMap((link) => {
    const row = evidenceMap.get(link.evidence_id);
    if (!row) return [];
    return [{
      id: row.id,
      source_type: row.source_type,
      locator: row.locator,
      supported_excerpt: row.supported_excerpt,
      source_time: row.source_time,
      captured_at: row.captured_at,
      has_file: Boolean(row.private_object_path),
      verified_at: row.verified_at,
      purpose: link.purpose,
    }];
  });
}

export async function getCaseTimeline(
  context: QueryContext,
  caseId: string,
): Promise<TimelineEntry[]> {
  const { client } = await singleCaseData(context, caseId);
  const [auditRows, actionRows, evidenceLinks] = await Promise.all([
    selectRows(
      client.from("audit_events").select("*")
        .eq("org_id", context.orgId).eq("case_id", caseId),
    ),
    selectRows(
      client.from("actions").select("*")
        .eq("org_id", context.orgId).eq("case_id", caseId),
    ),
    selectRows(
      client.from("case_evidence").select("evidence_id,purpose")
        .eq("org_id", context.orgId).eq("case_id", caseId),
    ),
  ]);
  const evidenceByPurpose = new Map<string, string[]>();
  for (const link of evidenceLinks) {
    const evidenceIds = evidenceByPurpose.get(link.purpose) ?? [];
    evidenceIds.push(link.evidence_id);
    evidenceByPurpose.set(link.purpose, evidenceIds);
  }
  const auditTimeline = auditRows.map((event): TimelineEntry => {
    const name = event.event_name as string;
    const group = name.includes("delay")
      ? "received_delay"
      : name.includes("matched") || name.includes("match")
        ? "matched_order"
        : name.includes("recalculat")
          ? "recalculated_stock"
          : name.includes("offer")
            ? "offer_verified"
            : name.includes("request") || name.includes("sent")
              ? "request_sent"
            : name.includes("approval")
              ? "approval"
            : name.includes("receipt")
              ? "receipt"
              : name.includes("execution")
                ? "execution"
              : "control";
    return {
      id: event.id,
      at: event.occurred_at,
      group,
      title: name.replaceAll(".", " ").replaceAll("_", " "),
      actor: { type: event.actor_type, label: event.actor_id ?? event.actor_type },
      status: "info",
      action_ref: null,
      evidence_ids: evidenceByPurpose.get(name) ?? [],
    };
  });
  const actionTimeline = actionRows.map((action): TimelineEntry => {
    const state = action.state as string;
    const status =
      state === "prepared" ? "intended" :
        state === "cancelled" || state === "failed" ? "failed" :
          state === "unknown" ? "unknown" :
            state === "submitted" ? "submitted" :
              state === "confirmed" ? "confirmed" : "intended";
    const evidenceIds = Array.isArray(action.payload?.evidence_ids)
      ? action.payload.evidence_ids
      : [];
    return {
      id: action.id,
      at: action.created_at,
      group: action.kind === "supplier_call" ? "call_outcome" : "request_sent",
      title:
        state === "dispatching"
          ? "Sending"
          : state === "cancelled"
            ? "Cancelled"
            : `${action.kind.replaceAll("_", " ")} ${state}`,
      actor: { type: "system", label: action.provider ?? "Conduit" },
      status,
      action_ref: action.id,
      evidence_ids: evidenceIds,
    };
  });
  return [...auditTimeline, ...actionTimeline].sort(
    (left, right) => new Date(left.at).getTime() - new Date(right.at).getTime(),
  );
}
