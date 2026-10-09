import type {
  ActionKind,
  ActionState,
  BlockReason,
  CasePhase,
  PlanStepKind,
  RunControl,
} from "@/lib/schemas/enums";

/** Rows mirror public.* columns; money minor units are decimal strings. */
export interface CaseRecord {
  id: string;
  org_id: string;
  item_id: string;
  location_id: string;
  phase: CasePhase;
  run_control: RunControl;
  block_reason: BlockReason | null;
  episode: number;
  current_assessment_id: string | null;
  next_check_at: string | null;
  row_version: number;
}

export interface ItemRecord {
  id: string;
  org_id: string;
  sku: string;
  description: string;
  base_unit: string;
  specification: Record<string, unknown>;
}

export interface LocationRecord {
  id: string;
  org_id: string;
  name: string;
  timezone: string;
}

export interface SupplierRecord {
  id: string;
  org_id: string;
  name: string;
  purchasing_status: "candidate" | "approved" | "blocked";
}

export interface SupplierItemRecord {
  id: string;
  org_id: string;
  supplier_id: string;
  item_id: string;
}

export interface ContactRecord {
  id: string;
  org_id: string;
  supplier_id: string;
  channel: "email" | "phone";
  normalized_address: string;
  display_name: string | null;
  timezone: string | null;
  permitted_channels: string[];
  outreach_approved_at: string | null;
}

export interface ReceiptScheduleRecord {
  id: string;
  po_line_id: string;
  quantity_remaining: number;
  earliest_at: string | null;
  latest_at: string | null;
  promise_state: string;
}

export interface CasePoLine {
  org_id: string;
  case_id: string;
  po_line_id: string;
  item_sku: string;
  purchase_order_external_id: string;
  item_id: string;
  destination_location_id: string;
  ordered_qty: number;
  received_qty: number;
  cancelled_qty: number;
  unit_price_minor: string;
  original_due_at: string | null;
  affected_qty: number;
  schedules: ReceiptScheduleRecord[];
}

export interface AssessmentRecord {
  id: string;
  org_id: string;
  case_id: string;
  version: number;
  input_fingerprint: string;
  policy_version_id: string | null;
  quality: "sufficient" | "insufficient";
  first_shortage_at: string | null;
  bridge_qty: number | null;
  projection: Record<string, unknown>;
  dated_requirements: { by: string; cumulative_quantity: number }[];
  evidence_ids: string[];
  source_as_of: string | null;
  horizon_start: string | null;
  horizon_end: string | null;
  created_at: string;
}

export interface OfferRecord {
  id: string;
  org_id: string;
  case_id: string;
  supplier_id: string;
  contact_id: string | null;
  evidence_ids: string[];
  source_type: string;
  source_summary: string | null;
}

export interface QuoteRecord {
  id: string;
  org_id: string;
  case_id: string;
  offer_id: string | null;
  supplier_id: string;
  contact_id: string | null;
  item_id: string;
  quantity: number | null;
  unit: string | null;
  unit_price_minor: string | null;
  currency: string | null;
  freight_minor: string | null;
  fees_minor: string | null;
  nonrecoverable_tax_minor: string | null;
  destination_location_id: string | null;
  arrival_start: string | null;
  arrival_end: string | null;
  valid_until: string | null;
  latest_order_at: string | null;
  status: string;
  evidence_ids: string[];
}

export interface ActionRecord {
  id: string;
  org_id: string;
  case_id: string;
  kind: ActionKind;
  state: ActionState;
  payload: Record<string, unknown>;
  payload_hash: string;
  idempotency_key: string;
  mode: string;
  created_at: string;
  /** F5 ledger columns — present on ledger-written rows. */
  contact_id?: string | null;
  episode?: number | null;
}

export interface EvidenceRecord {
  id: string;
  org_id: string;
  source_type: string;
  source_url: string | null;
  source_time: string | null;
  captured_at: string;
  content_hash: string;
  supported_excerpt: string | null;
}

export interface CaseEvidenceLink {
  org_id: string;
  case_id: string;
  evidence_id: string;
  purpose: string;
}

export interface PolicyRecord {
  id: string;
  org_id: string;
  version: number;
  settings: Record<string, unknown>;
}

export interface PlannerCycleRecord {
  id: string;
  org_id: string;
  case_id: string;
  episode: number;
  assessment_version: number;
  status: string;
  block_reason: string | null;
  model_requests: number;
  prompt_version: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface PlannerRequestRecord {
  id: string;
  org_id: string;
  case_id: string;
  cycle_id: string;
  episode: number;
  kind: "inference" | "repair" | "retry";
  outcome: string;
  provider: string | null;
  provider_request_id: string | null;
  model: string | null;
  prompt_version: string | null;
  estimated_cost: string | null;
}

export interface ResearchQueryRecord {
  id: string;
  org_id: string;
  case_id: string;
  episode: number;
  query: string;
  provider: string;
  mode: string;
  provider_request_id: string | null;
  result_count: number;
  cost_usd: string | null;
}

export interface SupplierCandidateRecord {
  id: string;
  org_id: string;
  case_id: string;
  research_query_id: string;
  name: string | null;
  domain: string | null;
  source_evidence_id: string | null;
  compatibility: "compatible" | "incompatible" | "unknown";
  status: "unapproved" | "dismissed";
  missing_facts: string[];
}

export interface PlannerWaitRecord {
  id: string;
  org_id: string;
  case_id: string;
  episode: number;
  expected_kind: "supplier_response" | "call_result" | "action_outcome";
  action_id: string | null;
  deadline_at: string;
  status: "pending" | "satisfied" | "expired" | "cancelled";
  created_at: string;
}

export interface PlannerReviewRecord {
  id: string;
  org_id: string;
  case_id: string;
  reason: string;
  missing_fields: string[];
  object_ids: string[];
  status: "open" | "resolved";
  created_by: string;
}

export interface RecoveryPlanRecord {
  id: string;
  org_id: string;
  case_id: string;
  version: number;
  assessment_id: string;
  status: string;
  gross_commitment_minor: string | null;
  incremental_cost_minor: string | null;
  evidence_ids: string[];
  missing_fields?: string[];
}

export interface PlanStepInsert {
  step_id: string;
  kind: PlanStepKind;
  quantity: number;
  quote_id?: string;
  depends_on_step_ids?: string[];
}

export interface CallSessionRecord {
  id: string;
  org_id: string;
  action_id: string;
  ended_at: string | null;
}

/** Result shape of F1's buildProjectionInput / loadProjectionInput. */
export type ProjectionFactsResult = ReturnType<
  typeof import("@/lib/domain/assessment-input").buildProjectionInput
>;


export interface UsageEventInput {
  orgId: string;
  caseId: string | null;
  actionId?: string | null;
  provider: string;
  requestId: string;
  chargeType: string;
  model?: string | null;
  rawUnits?: Record<string, number>;
  estimatedCost?: string | null;
  actualCost?: string | null;
  billingCurrency?: string | null;
  rateVersion?: string | null;
}

/**
 * Persistence boundary for the planner and its tools. Every method takes
 * orgId (and caseId where applicable) explicitly and every query filters by
 * org_id. All counts used for budgets come from these persisted records.
 */
export interface PlannerStore {
  getCase(orgId: string, caseId: string): Promise<CaseRecord | null>;
  /** Service-path lookup when org_id is not yet known (workflow entry). */
  getCaseByIdOnly?(caseId: string): Promise<CaseRecord | null>;
  updateCasePhase(
    orgId: string,
    caseId: string,
    phase: CasePhase,
    nextCheckAt?: string | null,
  ): Promise<void>;
  getItem(orgId: string, itemId: string): Promise<ItemRecord | null>;
  getLocation(orgId: string, locationId: string): Promise<LocationRecord | null>;
  getSupplier(orgId: string, supplierId: string): Promise<SupplierRecord | null>;
  getContact(orgId: string, contactId: string): Promise<ContactRecord | null>;
  listApprovedSuppliers(
    orgId: string,
    itemId: string,
  ): Promise<{ supplier: SupplierRecord; contacts: ContactRecord[] }[]>;
  getCurrentAssessment(
    orgId: string,
    caseId: string,
  ): Promise<AssessmentRecord | null>;
  getAssessmentByVersion(
    orgId: string,
    caseId: string,
    version: number,
  ): Promise<AssessmentRecord | null>;
  getAssessmentById(
    orgId: string,
    caseId: string,
    assessmentId: string,
  ): Promise<AssessmentRecord | null>;
  insertAssessment(
    record: Omit<AssessmentRecord, "id" | "created_at">,
  ): Promise<AssessmentRecord>;
  setCurrentAssessment(
    orgId: string,
    caseId: string,
    assessmentId: string,
  ): Promise<void>;
  listCasePoLines(orgId: string, caseId: string): Promise<CasePoLine[]>;
  findOrderCandidates(
    orgId: string,
    orderRefs: string[],
    itemRefs: string[],
  ): Promise<CasePoLine[]>;
  listOffers(orgId: string, caseId: string): Promise<OfferRecord[]>;
  listQuotes(orgId: string, caseId: string): Promise<QuoteRecord[]>;
  getQuote(
    orgId: string,
    caseId: string,
    quoteId: string,
  ): Promise<QuoteRecord | null>;
  insertOffer(
    record: Omit<OfferRecord, "id">,
  ): Promise<OfferRecord>;
  insertQuote(
    record: Omit<QuoteRecord, "id">,
  ): Promise<QuoteRecord>;
  listActions(orgId: string, caseId: string): Promise<ActionRecord[]>;
  getAction(
    orgId: string,
    caseId: string,
    actionId: string,
  ): Promise<ActionRecord | null>;
  getOrgMode(orgId: string): Promise<"replay" | "sandbox" | "live" | null>;
  updateActionState?(
    orgId: string,
    caseId: string,
    actionId: string,
    state: ActionState,
  ): Promise<void>;
  getEvidence(orgId: string, evidenceId: string): Promise<EvidenceRecord | null>;
  findCaseEvidence(
    orgId: string,
    caseId: string,
    evidenceId: string,
    purpose?: string,
  ): Promise<CaseEvidenceLink | null>;
  listCaseEvidence(orgId: string, caseId: string): Promise<EvidenceRecord[]>;
  insertEvidence(
    record: Omit<EvidenceRecord, "id">,
  ): Promise<EvidenceRecord>;
  linkCaseEvidence(link: CaseEvidenceLink): Promise<void>;
  insertResearchQuery(
    record: Omit<ResearchQueryRecord, "id" | "created_at">,
  ): Promise<ResearchQueryRecord>;
  countResearchQueries(
    orgId: string,
    caseId: string,
    episode: number,
  ): Promise<number>;
  insertSupplierCandidate(
    record: Omit<SupplierCandidateRecord, "id">,
  ): Promise<SupplierCandidateRecord>;
  countPageReads(
    orgId: string,
    caseId: string,
    episode: number,
  ): Promise<number>;
  hasPageRead(
    orgId: string,
    caseId: string,
    episode: number,
    evidenceId: string,
  ): Promise<boolean>;
  insertPageRead(
    orgId: string,
    caseId: string,
    episode: number,
    evidenceId: string,
  ): Promise<void>;
  insertReview(
    record: Omit<PlannerReviewRecord, "id">,
  ): Promise<PlannerReviewRecord>;
  insertWait(
    record: Omit<PlannerWaitRecord, "id">,
  ): Promise<PlannerWaitRecord>;
  listWaits(orgId: string, caseId: string): Promise<PlannerWaitRecord[]>;
  updateWaitStatus(
    orgId: string,
    caseId: string,
    waitId: string,
    status: PlannerWaitRecord["status"],
  ): Promise<void>;
  /** Persisted evidence that a wait condition is already satisfied. */
  findSatisfiedWait(
    orgId: string,
    caseId: string,
    wait: PlannerWaitRecord,
  ): Promise<boolean>;
  /** Insert-if-absent by id — safe under Inngest replay. */
  insertCycle(record: PlannerCycleRecord): Promise<PlannerCycleRecord>;
  updateCycle(
    orgId: string,
    cycleId: string,
    patch: Partial<PlannerCycleRecord>,
  ): Promise<void>;
  insertPlannerRequest(
    record: Omit<PlannerRequestRecord, "id">,
  ): Promise<PlannerRequestRecord>;
  countPlannerRequests(
    orgId: string,
    caseId: string,
    episode: number,
    cycleId?: string,
  ): Promise<number>;
  insertUsageEvent(input: UsageEventInput): Promise<void>;
  getCurrentPolicy(orgId: string): Promise<PolicyRecord | null>;
  insertRecoveryPlan(input: {
    orgId: string;
    caseId: string;
    version: number;
    assessmentId: string;
    status: string;
    grossCommitmentMinor: string | null;
    incrementalCostMinor: string | null;
    evidenceIds: string[];
    steps: (PlanStepInsert & { item_id: string; unit: string; missing_fields: string[] })[];
  }): Promise<RecoveryPlanRecord>;
  nextPlanVersion(orgId: string, caseId: string): Promise<number>;
  getCallSessionForAction(
    orgId: string,
    caseId: string,
    actionId: string,
  ): Promise<CallSessionRecord | null>;
  loadProjectionInput(orgId: string, caseId: string): Promise<ProjectionFactsResult>;
  insertAudit?(entry: {
    org_id: string;
    case_id?: string | null;
    actor_type: string;
    entity_type: string;
    entity_id?: string | null;
    event_name: string;
    reason?: string | null;
  }): Promise<void>;
}
