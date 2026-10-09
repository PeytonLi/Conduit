import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ActionRecord,
  AssessmentRecord,
  CasePoLine,
  ContactRecord,
  EvidenceRecord,
  OfferRecord,
  PlanStepInsert,
  QuoteRecord,
  RecoveryPlanRecord,
  SupplierRecord,
  PlannerCycleRecord,
  PlannerStore,
  PlannerWaitRecord,
  ProjectionFactsResult,
  UsageEventInput,
} from "./store";
import type { CasePhase, ActionState } from "@/lib/schemas/enums";


type Row = Record<string, unknown>;

function must<T>(data: T | null, error: { message: string } | null): T {
  if (error) throw new Error(error.message);
  return data as T;
}

/** Supabase-backed PlannerStore using the service client (created lazily). */
export class SupabasePlannerStore implements PlannerStore {
  private client: SupabaseClient | null = null;

  constructor(client?: SupabaseClient) {
    this.client = client ?? null;
  }

  private async db(): Promise<SupabaseClient> {
    if (!this.client) {
      // Lazy dynamic import keeps "server-only" out of unit-test import graphs.
      const { createServiceClient } = await import("@/lib/db/service");
      this.client = createServiceClient();
    }
    return this.client;
  }

  async getCase(orgId: string, caseId: string) {
    const { data, error } = await (await this.db())
      .from("cases")
      .select("*")
      .eq("org_id", orgId)
      .eq("id", caseId)
      .maybeSingle();
    must(data, error);
    return data;
  }

  async getCaseByIdOnly(caseId: string) {
    const { data, error } = await (await this.db())
      .from("cases")
      .select("*")
      .eq("id", caseId)
      .maybeSingle();
    must(data, error);
    return data;
  }

  async updateCasePhase(
    orgId: string,
    caseId: string,
    phase: CasePhase,
    nextCheckAt?: string | null,
  ) {
    const patch: Row = { phase };
    if (nextCheckAt !== undefined) patch.next_check_at = nextCheckAt;
    const { error } = await (await this.db())
      .from("cases")
      .update(patch)
      .eq("org_id", orgId)
      .eq("id", caseId);
    must(null, error);
  }

  private async byId(table: string, orgId: string, id: string) {
    const { data, error } = await (await this.db())
      .from(table)
      .select("*")
      .eq("org_id", orgId)
      .eq("id", id)
      .maybeSingle();
    must(data, error);
    return data;
  }

  getItem(orgId: string, itemId: string) {
    return this.byId("items", orgId, itemId);
  }
  getLocation(orgId: string, locationId: string) {
    return this.byId("locations", orgId, locationId);
  }
  getSupplier(orgId: string, supplierId: string) {
    return this.byId("suppliers", orgId, supplierId);
  }
  getContact(orgId: string, contactId: string) {
    return this.byId("supplier_contacts", orgId, contactId);
  }

  async listApprovedSuppliers(
    orgId: string,
    itemId: string,
  ): Promise<{ supplier: SupplierRecord; contacts: ContactRecord[] }[]> {
    const { data: links, error } = await (await this.db())
      .from("supplier_items")
      .select("supplier_id")
      .eq("org_id", orgId)
      .eq("item_id", itemId);
    must(links, error);
    const supplierIds = (links ?? []).map((l: Row) => l.supplier_id as string);
    if (!supplierIds.length) return [];
    const { data: suppliers, error: e2 } = await (await this.db())
      .from("suppliers")
      .select("*")
      .eq("org_id", orgId)
      .eq("purchasing_status", "approved")
      .in("id", supplierIds);
    must(suppliers, e2);
    const { data: contacts, error: e3 } = await (await this.db())
      .from("supplier_contacts")
      .select("*")
      .eq("org_id", orgId)
      .in("supplier_id", supplierIds)
      .not("outreach_approved_at", "is", null);
    must(contacts, e3);
    return (suppliers ?? []).map((s: Row) => ({
      supplier: s as unknown as SupplierRecord,
      contacts: ((contacts ?? []) as Row[]).filter(
        (c: Row) => c.supplier_id === s.id,
      ) as unknown as ContactRecord[],
    }));
  }

  private async getAssessment(where: Record<string, unknown>) {
    let q = (await this.db()).from("assessments").select("*");
    for (const [k, v] of Object.entries(where)) q = q.eq(k, v as string);
    const { data, error } = await q.maybeSingle();
    must(data, error);
    return data as AssessmentRecord | null;
  }

  async getCurrentAssessment(orgId: string, caseId: string) {
    const c = await this.getCase(orgId, caseId);
    if (!c?.current_assessment_id) return null;
    return this.getAssessment({
      org_id: orgId,
      case_id: caseId,
      id: c.current_assessment_id,
    });
  }

  getAssessmentByVersion(orgId: string, caseId: string, version: number) {
    return this.getAssessment({ org_id: orgId, case_id: caseId, version });
  }

  getAssessmentById(orgId: string, caseId: string, assessmentId: string) {
    return this.getAssessment({
      org_id: orgId,
      case_id: caseId,
      id: assessmentId,
    });
  }

  async insertAssessment(record: Omit<AssessmentRecord, "id" | "created_at">) {
    const { data, error } = await (await this.db())
      .from("assessments")
      .insert(record as Row)
      .select("*")
      .single();
    return must(data, error);
  }

  async setCurrentAssessment(orgId: string, caseId: string, assessmentId: string) {
    const { error } = await (await this.db())
      .from("cases")
      .update({ current_assessment_id: assessmentId })
      .eq("org_id", orgId)
      .eq("id", caseId);
    must(null, error);
  }

  async listCasePoLines(orgId: string, caseId: string): Promise<CasePoLine[]> {
    const { data: links, error } = await (await this.db())
      .from("case_order_lines")
      .select("po_line_id, affected_qty")
      .eq("org_id", orgId)
      .eq("case_id", caseId);
    must(links, error);
    const out: CasePoLine[] = [];
    for (const link of links ?? []) {
      const { data: line } = await (await this.db())
        .from("purchase_order_lines")
        .select("*, purchase_orders(external_id), items(sku), receipt_schedules(*)")
        .eq("org_id", orgId)
        .eq("id", link.po_line_id)
        .single();
      if (!line) continue;
      const l = line as Row;
      out.push({
        org_id: orgId,
        case_id: caseId,
        po_line_id: l.id as string,
        purchase_order_external_id:
          ((l.purchase_orders as Row)?.external_id as string) ?? "",
        item_sku: ((l.items as Row)?.sku as string) ?? "",
        item_id: l.item_id as string,
        destination_location_id: l.destination_location_id as string,
        ordered_qty: l.ordered_qty as number,
        received_qty: l.received_qty as number,
        cancelled_qty: l.cancelled_qty as number,
        unit_price_minor: String(l.unit_price_minor),
        original_due_at: l.original_due_at as string | null,
        affected_qty: link.affected_qty as number,
        schedules: (l.receipt_schedules as Row[] ?? []).map((s) => ({
          id: s.id as string,
          po_line_id: s.po_line_id as string,
          quantity_remaining: s.quantity_remaining as number,
          earliest_at: s.earliest_at as string | null,
          latest_at: s.latest_at as string | null,
          promise_state: s.promise_state as string,
        })),
      });
    }
    return out;
  }

  async findOrderCandidates(orgId: string, orderRefs: string[], itemRefs: string[]) {
    const { data: pos, error } = await (await this.db())
      .from("purchase_orders")
      .select("id")
      .eq("org_id", orgId)
      .in("external_id", orderRefs);
    must(pos, error);
    const poIds = (pos ?? []).map((p: Row) => p.id as string);
    const { data: items } = await (await this.db())
      .from("items")
      .select("id")
      .eq("org_id", orgId)
      .in("sku", itemRefs);
    const itemIds = (items ?? []).map((i: Row) => i.id as string);
    let q = (await this.db())
      .from("purchase_order_lines")
      .select("*, purchase_orders(external_id), items(sku), receipt_schedules(*)")
      .eq("org_id", orgId);
    if (poIds.length && itemIds.length) {
      q = q.or(
        `purchase_order_id.in.(${poIds.join(",")}),item_id.in.(${itemIds.join(",")})`,
      );
    } else if (poIds.length) {
      q = q.in("purchase_order_id", poIds);
    } else if (itemIds.length) {
      q = q.in("item_id", itemIds);
    } else {
      return [];
    }
    const { data: lines, error: e2 } = await q;
    must(lines, e2);
    return (lines ?? []).map((l: Row) => ({
      org_id: orgId,
      case_id: "",
      po_line_id: l.id as string,
      purchase_order_external_id:
        ((l.purchase_orders as Row)?.external_id as string) ?? "",
      item_sku: ((l.items as Row)?.sku as string) ?? "",
      item_id: l.item_id as string,
      destination_location_id: l.destination_location_id as string,
      ordered_qty: l.ordered_qty as number,
      received_qty: l.received_qty as number,
      cancelled_qty: l.cancelled_qty as number,
      unit_price_minor: String(l.unit_price_minor),
      original_due_at: l.original_due_at as string | null,
      affected_qty: 0,
      schedules: (l.receipt_schedules as Row[] ?? []).map((s) => ({
        id: s.id as string,
        po_line_id: s.po_line_id as string,
        quantity_remaining: s.quantity_remaining as number,
        earliest_at: s.earliest_at as string | null,
        latest_at: s.latest_at as string | null,
        promise_state: s.promise_state as string,
      })),
    }));
  }

  private async listWhere<T>(table: string, orgId: string, caseId: string): Promise<T[]> {
    const { data, error } = await (await this.db())
      .from(table)
      .select("*")
      .eq("org_id", orgId)
      .eq("case_id", caseId);
    must(data, error);
    return (data ?? []) as T[];
  }

  listOffers(orgId: string, caseId: string) {
    return this.listWhere<OfferRecord>("offers", orgId, caseId);
  }
  listQuotes(orgId: string, caseId: string) {
    return this.listWhere<QuoteRecord>("quotes", orgId, caseId);
  }
  listActions(orgId: string, caseId: string) {
    return this.listWhere<ActionRecord>("actions", orgId, caseId);
  }

  async getQuote(orgId: string, caseId: string, quoteId: string) {
    const { data, error } = await (await this.db())
      .from("quotes")
      .select("*")
      .eq("org_id", orgId)
      .eq("case_id", caseId)
      .eq("id", quoteId)
      .maybeSingle();
    must(data, error);
    return data;
  }

  async getAction(orgId: string, caseId: string, actionId: string) {
    const { data, error } = await (await this.db())
      .from("actions")
      .select("*")
      .eq("org_id", orgId)
      .eq("case_id", caseId)
      .eq("id", actionId)
      .maybeSingle();
    must(data, error);
    return data;
  }

  async insertOffer(record: Row) {
    const { data, error } = await (await this.db())
      .from("offers")
      .insert(record)
      .select("*")
      .single();
    return must(data, error);
  }

  async insertQuote(record: Row) {
    const { data, error } = await (await this.db())
      .from("quotes")
      .insert(record)
      .select("*")
      .single();
    return must(data, error);
  }

  async getOrgMode(orgId: string) {
    const { data, error } = await (await this.db())
      .from("organizations")
      .select("environment_mode")
      .eq("id", orgId)
      .maybeSingle();
    must(data, error);
    return (data?.environment_mode as "replay" | "sandbox" | "live") ?? null;
  }

  async updateActionState(
    orgId: string,
    caseId: string,
    actionId: string,
    state: ActionState,
  ) {
    const { error } = await (await this.db())
      .from("actions")
      .update({ state })
      .eq("org_id", orgId)
      .eq("case_id", caseId)
      .eq("id", actionId);
    must(null, error);
  }

  getEvidence(orgId: string, evidenceId: string) {
    return this.byId("evidence", orgId, evidenceId);
  }

  async findCaseEvidence(
    orgId: string,
    caseId: string,
    evidenceId: string,
    purpose?: string,
  ) {
    let q = (await this.db())
      .from("case_evidence")
      .select("*")
      .eq("org_id", orgId)
      .eq("case_id", caseId)
      .eq("evidence_id", evidenceId);
    if (purpose) q = q.eq("purpose", purpose);
    const { data, error } = await q.maybeSingle();
    must(data, error);
    return data;
  }

  async listCaseEvidence(orgId: string, caseId: string) {
    const { data, error } = await (await this.db())
      .from("case_evidence")
      .select("evidence_id, evidence(*)")
      .eq("org_id", orgId)
      .eq("case_id", caseId);
    must(data, error);
    return (data ?? []).map((r: Row) => r.evidence) as EvidenceRecord[];
  }

  async insertEvidence(record: Row) {
    const { data, error } = await (await this.db())
      .from("evidence")
      .insert(record)
      .select("*")
      .single();
    return must(data, error);
  }

  async linkCaseEvidence(link: {
    org_id: string;
    case_id: string;
    evidence_id: string;
    purpose: string;
  }) {
    const { error } = await (await this.db())
      .from("case_evidence")
      .upsert(link, { onConflict: "org_id,case_id,evidence_id,purpose" });
    must(null, error);
  }

  async insertResearchQuery(record: Row) {
    const { data, error } = await (await this.db())
      .from("research_queries")
      .insert(record)
      .select("*")
      .single();
    return must(data, error);
  }

  async countResearchQueries(orgId: string, caseId: string, episode: number) {
    const { count, error } = await (await this.db())
      .from("research_queries")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("case_id", caseId)
      .eq("episode", episode);
    must(null, error);
    return count ?? 0;
  }

  async insertSupplierCandidate(record: Row) {
    const { data, error } = await (await this.db())
      .from("supplier_candidates")
      .insert(record)
      .select("*")
      .single();
    return must(data, error);
  }

  async countPageReads(orgId: string, caseId: string, episode: number) {
    const { data, error } = await (await this.db())
      .from("research_page_reads")
      .select("evidence_id")
      .eq("org_id", orgId)
      .eq("case_id", caseId)
      .eq("episode", episode);
    must(data, error);
    return new Set((data ?? []).map((r: Row) => r.evidence_id)).size;
  }

  async hasPageRead(
    orgId: string,
    caseId: string,
    episode: number,
    evidenceId: string,
  ) {
    const { data, error } = await (await this.db())
      .from("research_page_reads")
      .select("evidence_id")
      .eq("org_id", orgId)
      .eq("case_id", caseId)
      .eq("episode", episode)
      .eq("evidence_id", evidenceId)
      .maybeSingle();
    must(null, error);
    return Boolean(data);
  }

  async insertPageRead(
    orgId: string,
    caseId: string,
    episode: number,
    evidenceId: string,
  ) {
    const { error } = await (await this.db())
      .from("research_page_reads")
      .upsert(
        { org_id: orgId, case_id: caseId, episode, evidence_id: evidenceId },
        { onConflict: "org_id,case_id,episode,evidence_id", ignoreDuplicates: true },
      );
    must(null, error);
  }

  async insertReview(record: Row) {
    const { data, error } = await (await this.db())
      .from("planner_reviews")
      .insert(record)
      .select("*")
      .single();
    return must(data, error);
  }

  async insertWait(record: Row) {
    const { data, error } = await (await this.db())
      .from("planner_waits")
      .insert(record)
      .select("*")
      .single();
    return must(data, error);
  }

  async listWaits(orgId: string, caseId: string) {
    const { data, error } = await (await this.db())
      .from("planner_waits")
      .select("*")
      .eq("org_id", orgId)
      .eq("case_id", caseId);
    must(data, error);
    return (data ?? []) as PlannerWaitRecord[];
  }

  async updateWaitStatus(
    orgId: string,
    caseId: string,
    waitId: string,
    status: PlannerWaitRecord["status"],
  ) {
    const { error } = await (await this.db())
      .from("planner_waits")
      .update({ status })
      .eq("org_id", orgId)
      .eq("case_id", caseId)
      .eq("id", waitId);
    must(null, error);
  }

  async findSatisfiedWait(
    orgId: string,
    caseId: string,
    wait: PlannerWaitRecord,
  ): Promise<boolean> {
    if (wait.expected_kind === "supplier_response") {
      const { data } = await (await this.db())
        .from("case_evidence")
        .select("evidence_id, evidence(captured_at)")
        .eq("org_id", orgId)
        .eq("case_id", caseId)
        .eq("purpose", "supplier_response");
      return (data ?? []).some((r: Row) => {
        const captured = (r.evidence as Row)?.captured_at as string | undefined;
        return captured !== undefined && captured >= wait.created_at;
      });
    }
    if (!wait.action_id) return false;
    if (wait.expected_kind === "call_result") {
      const { data } = await (await this.db())
        .from("call_sessions")
        .select("id")
        .eq("org_id", orgId)
        .eq("action_id", wait.action_id)
        .not("ended_at", "is", null)
        .maybeSingle();
      return Boolean(data);
    }
    const action = await this.getAction(orgId, caseId, wait.action_id);
    return Boolean(action && !["prepared", "dispatching"].includes(action.state));
  }

  async insertCycle(record: PlannerCycleRecord) {
    const { data: existing } = await (await this.db())
      .from("planner_cycles")
      .select("*")
      .eq("org_id", record.org_id)
      .eq("id", record.id)
      .maybeSingle();
    if (existing) return existing as PlannerCycleRecord;
    const { data, error } = await (await this.db())
      .from("planner_cycles")
      .insert(record)
      .select("*")
      .single();
    return must(data, error) as PlannerCycleRecord;
  }

  async updateCycle(orgId: string, cycleId: string, patch: Row) {
    const { error } = await (await this.db())
      .from("planner_cycles")
      .update(patch)
      .eq("org_id", orgId)
      .eq("id", cycleId);
    must(null, error);
  }

  async insertPlannerRequest(record: Row) {
    const { data, error } = await (await this.db())
      .from("planner_requests")
      .insert(record)
      .select("*")
      .single();
    return must(data, error);
  }

  async countPlannerRequests(
    orgId: string,
    caseId: string,
    episode: number,
    cycleId?: string,
  ) {
    let q = (await this.db())
      .from("planner_requests")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("case_id", caseId)
      .eq("episode", episode);
    if (cycleId) q = q.eq("cycle_id", cycleId);
    const { count, error } = await q;
    must(null, error);
    return count ?? 0;
  }

  async insertUsageEvent(input: UsageEventInput) {
    const { error } = await (await this.db())
      .from("usage_events")
      .insert({
        org_id: input.orgId,
        case_id: input.caseId,
        action_id: input.actionId ?? null,
        provider: input.provider,
        request_id: input.requestId,
        charge_type: input.chargeType,
        model: input.model ?? null,
        raw_units: input.rawUnits ?? {},
        estimated_cost: input.estimatedCost ?? null,
        actual_cost: input.actualCost ?? null,
        billing_currency: input.billingCurrency ?? null,
        rate_version: input.rateVersion ?? null,
      });
    must(null, error);
  }

  async getCurrentPolicy(orgId: string) {
    const { data, error } = await (await this.db())
      .from("policies")
      .select("*")
      .eq("org_id", orgId)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    must(data, error);
    return data;
  }

  async insertRecoveryPlan(input: {
    orgId: string;
    caseId: string;
    version: number;
    assessmentId: string;
    status: string;
    grossCommitmentMinor: string | null;
    incrementalCostMinor: string | null;
    evidenceIds: string[];
    steps: (PlanStepInsert & {
      item_id: string;
      unit: string;
      missing_fields: string[];
    })[];
  }) {
    const { data: plan, error } = await (await this.db())
      .from("recovery_plans")
      .insert({
        org_id: input.orgId,
        case_id: input.caseId,
        version: input.version,
        assessment_id: input.assessmentId,
        status: input.status,
        gross_commitment_minor: input.grossCommitmentMinor,
        incremental_cost_minor: input.incrementalCostMinor,
        evidence_ids: input.evidenceIds,
        input_fingerprint: "",
      })
      .select("*")
      .single();
    const row = must(plan, error) as Row;
    for (const step of input.steps) {
      const { error: se } = await (await this.db())
        .from("plan_steps")
        .insert({
          org_id: input.orgId,
          plan_id: row.id,
          step_id: step.step_id,
          kind: step.kind,
          item_id: step.item_id,
          quantity: step.quantity,
          unit: step.unit,
          depends_on_step_ids: step.depends_on_step_ids ?? [],
          evidence_ids: input.evidenceIds,
          execution_mode: "manual",
          missing_fields: step.missing_fields ?? [],
          payload: step.quote_id ? { quote_id: step.quote_id } : {},
        });
      must(null, se);
    }
    return row as unknown as RecoveryPlanRecord;
  }

  async nextPlanVersion(orgId: string, caseId: string) {
    const { data, error } = await (await this.db())
      .from("recovery_plans")
      .select("version")
      .eq("org_id", orgId)
      .eq("case_id", caseId)
      .order("version", { ascending: false })
      .limit(1);
    must(data, error);
    const latest = (data?.[0] as Row | undefined)?.version as number | undefined;
    return (latest ?? 0) + 1;
  }

  async getCallSessionForAction(orgId: string, _caseId: string, actionId: string) {
    const { data, error } = await (await this.db())
      .from("call_sessions")
      .select("*")
      .eq("org_id", orgId)
      .eq("action_id", actionId)
      .maybeSingle();
    must(data, error);
    return data;
  }

  async loadProjectionInput(orgId: string, caseId: string): Promise<ProjectionFactsResult> {
    const c = await this.getCase(orgId, caseId);
    if (!c) throw new Error("case not found");
    // Lazy import keeps "server-only" out of unit-test import graphs.
    const imports = await import("@/lib/db/imports");
    return imports.loadProjectionInput(imports.createSupabaseImportStore(), {
      orgId,
      itemId: c.item_id,
      locationId: c.location_id,
    });
  }

  async insertAudit(entry: Row) {
    const { error } = await (await this.db())
      .from("audit_events")
      .insert({
        org_id: entry.org_id,
        case_id: entry.case_id ?? null,
        actor_type: entry.actor_type,
        entity_type: entry.entity_type,
        entity_id: entry.entity_id ?? null,
        event_name: entry.event_name,
        reason: entry.reason ?? null,
      });
    must(null, error);
  }
}
