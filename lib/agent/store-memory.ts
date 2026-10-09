import { createHash, randomUUID } from "node:crypto";
import type {
  ActionRecord,
  AssessmentRecord,
  CaseEvidenceLink,
  CasePoLine,
  CaseRecord,
  CallSessionRecord,
  ContactRecord,
  EvidenceRecord,
  ItemRecord,
  LocationRecord,
  OfferRecord,
  PlanStepInsert,
  PlannerCycleRecord,
  PlannerRequestRecord,
  PlannerReviewRecord,
  PlannerStore,
  PlannerWaitRecord,
  PolicyRecord,
  PrepareActionInput,
  PreparedActionResult,
  QuoteRecord,
  RecoveryPlanRecord,
  ResearchQueryRecord,
  SupplierCandidateRecord,
  SupplierItemRecord,
  SupplierRecord,
  UsageEventInput,
} from "./store";
import type { CasePhase, ActionState } from "@/lib/schemas/enums";
import type { ProjectionInput } from "@/lib/domain/types";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface MemorySeed {
  cases?: CaseRecord[];
  items?: ItemRecord[];
  locations?: LocationRecord[];
  suppliers?: SupplierRecord[];
  supplierItems?: SupplierItemRecord[];
  contacts?: ContactRecord[];
  assessments?: AssessmentRecord[];
  casePoLines?: CasePoLine[];
  offers?: OfferRecord[];
  quotes?: QuoteRecord[];
  actions?: ActionRecord[];
  evidence?: EvidenceRecord[];
  caseEvidence?: CaseEvidenceLink[];
  policies?: PolicyRecord[];
  waits?: PlannerWaitRecord[];
  reviews?: PlannerReviewRecord[];
  cycles?: PlannerCycleRecord[];
  requests?: PlannerRequestRecord[];
  researchQueries?: ResearchQueryRecord[];
  pageReads?: { org_id: string; case_id: string; episode: number; evidence_id: string }[];
  callSessions?: CallSessionRecord[];
  plans?: RecoveryPlanRecord[];
  projectionInput?: ProjectionInput;
}

/** In-memory PlannerStore fake for unit tests. */
export class MemoryPlannerStore implements PlannerStore {
  cases = new Map<string, CaseRecord>();
  items = new Map<string, ItemRecord>();
  locations = new Map<string, LocationRecord>();
  suppliers = new Map<string, SupplierRecord>();
  supplierItems: SupplierItemRecord[] = [];
  contacts = new Map<string, ContactRecord>();
  assessments = new Map<string, AssessmentRecord>();
  casePoLines: CasePoLine[] = [];
  offers = new Map<string, OfferRecord>();
  quotes = new Map<string, QuoteRecord>();
  actions = new Map<string, ActionRecord>();
  evidence = new Map<string, EvidenceRecord>();
  caseEvidence: CaseEvidenceLink[] = [];
  policies: PolicyRecord[] = [];
  waits = new Map<string, PlannerWaitRecord>();
  reviews = new Map<string, PlannerReviewRecord>();
  cycles = new Map<string, PlannerCycleRecord>();
  requests = new Map<string, PlannerRequestRecord>();
  researchQueries = new Map<string, ResearchQueryRecord>();
  pageReads: { org_id: string; case_id: string; episode: number; evidence_id: string }[] = [];
  callSessions = new Map<string, CallSessionRecord>();
  plans = new Map<string, RecoveryPlanRecord>();
  planSteps: (PlanStepInsert & { plan_id: string })[] = [];
  usageEvents: UsageEventInput[] = [];
  audits: { event_name: string; entity_type: string }[] = [];
  projectionInput: ProjectionInput | null = null;

  constructor(seed: MemorySeed = {}) {
    for (const c of seed.cases ?? []) this.cases.set(c.id, c);
    for (const i of seed.items ?? []) this.items.set(i.id, i);
    for (const l of seed.locations ?? []) this.locations.set(l.id, l);
    for (const s of seed.suppliers ?? []) this.suppliers.set(s.id, s);
    this.supplierItems = [...(seed.supplierItems ?? [])];
    for (const c of seed.contacts ?? []) this.contacts.set(c.id, c);
    for (const a of seed.assessments ?? []) this.assessments.set(a.id, a);
    this.casePoLines = [...(seed.casePoLines ?? [])];
    for (const o of seed.offers ?? []) this.offers.set(o.id, o);
    for (const q of seed.quotes ?? []) this.quotes.set(q.id, q);
    for (const a of seed.actions ?? []) this.actions.set(a.id, a);
    for (const e of seed.evidence ?? []) this.evidence.set(e.id, e);
    this.caseEvidence = [...(seed.caseEvidence ?? [])];
    this.policies = [...(seed.policies ?? [])];
    for (const w of seed.waits ?? []) this.waits.set(w.id, w);
    for (const r of seed.reviews ?? []) this.reviews.set(r.id, r);
    for (const c of seed.cycles ?? []) this.cycles.set(c.id, c);
    for (const r of seed.requests ?? []) this.requests.set(r.id, r);
    for (const q of seed.researchQueries ?? []) this.researchQueries.set(q.id, q);
    this.pageReads = [...(seed.pageReads ?? [])];
    for (const s of seed.callSessions ?? []) this.callSessions.set(s.id, s);
    for (const p of seed.plans ?? []) this.plans.set(p.id, p);
    this.projectionInput = seed.projectionInput ?? null;
  }

  private scoped<T extends { id: string; org_id: string }>(
    map: Map<string, T>,
    orgId: string,
    id: string,
  ): T | null {
    const row = map.get(id);
    return row && row.org_id === orgId ? row : null;
  }

  async getCase(orgId: string, caseId: string) {
    return this.scoped(this.cases, orgId, caseId);
  }

  async getCaseByIdOnly(caseId: string) {
    return this.cases.get(caseId) ?? null;
  }

  async updateCasePhase(
    orgId: string,
    caseId: string,
    phase: CasePhase,
    nextCheckAt?: string | null,
  ) {
    const row = await this.getCase(orgId, caseId);
    if (!row) throw new Error("case not found");
    row.phase = phase;
    row.row_version += 1;
    if (nextCheckAt !== undefined) row.next_check_at = nextCheckAt;
  }

  async getItem(orgId: string, itemId: string) {
    return this.scoped(this.items, orgId, itemId);
  }
  async getLocation(orgId: string, locationId: string) {
    return this.scoped(this.locations, orgId, locationId);
  }
  async getSupplier(orgId: string, supplierId: string) {
    return this.scoped(this.suppliers, orgId, supplierId);
  }
  async getContact(orgId: string, contactId: string) {
    return this.scoped(this.contacts, orgId, contactId);
  }

  async listApprovedSuppliers(orgId: string, itemId: string) {
    const supplierIds = new Set(
      this.supplierItems
        .filter((si) => si.org_id === orgId && si.item_id === itemId)
        .map((si) => si.supplier_id),
    );
    const out: { supplier: SupplierRecord; contacts: ContactRecord[] }[] = [];
    for (const supplier of this.suppliers.values()) {
      if (supplier.org_id !== orgId) continue;
      if (supplier.purchasing_status !== "approved") continue;
      if (!supplierIds.has(supplier.id)) continue;
      const contacts = [...this.contacts.values()].filter(
        (c) =>
          c.org_id === orgId &&
          c.supplier_id === supplier.id &&
          c.outreach_approved_at !== null,
      );
      out.push({ supplier, contacts });
    }
    return out;
  }

  async getCurrentAssessment(orgId: string, caseId: string) {
    const row = await this.getCase(orgId, caseId);
    if (!row?.current_assessment_id) return null;
    const a = this.assessments.get(row.current_assessment_id);
    return a && a.org_id === orgId && a.case_id === caseId ? a : null;
  }

  async getAssessmentByVersion(orgId: string, caseId: string, version: number) {
    for (const a of this.assessments.values()) {
      if (a.org_id === orgId && a.case_id === caseId && a.version === version) return a;
    }
    return null;
  }

  async getAssessmentById(orgId: string, caseId: string, assessmentId: string) {
    const a = this.assessments.get(assessmentId);
    return a && a.org_id === orgId && a.case_id === caseId ? a : null;
  }

  async insertAssessment(record: Omit<AssessmentRecord, "id" | "created_at">) {
    const row: AssessmentRecord = {
      ...record,
      id: randomUUID(),
      created_at: new Date(0).toISOString(),
    };
    this.assessments.set(row.id, row);
    return row;
  }

  async setCurrentAssessment(orgId: string, caseId: string, assessmentId: string) {
    const row = await this.getCase(orgId, caseId);
    if (!row) throw new Error("case not found");
    row.current_assessment_id = assessmentId;
  }

  async listCasePoLines(orgId: string, caseId: string) {
    return this.casePoLines.filter(
      (l) => l.org_id === orgId && l.case_id === caseId,
    );
  }

  async findOrderCandidates(orgId: string, orderRefs: string[], itemRefs: string[]) {
    return this.casePoLines.filter(
      (l) =>
        l.org_id === orgId &&
        (orderRefs.includes(l.purchase_order_external_id) ||
          itemRefs.includes(l.item_sku)),
    );
  }

  async listOffers(orgId: string, caseId: string) {
    return [...this.offers.values()].filter(
      (o) => o.org_id === orgId && o.case_id === caseId,
    );
  }

  async listQuotes(orgId: string, caseId: string) {
    return [...this.quotes.values()].filter(
      (q) => q.org_id === orgId && q.case_id === caseId,
    );
  }

  async getQuote(orgId: string, caseId: string, quoteId: string) {
    const q = this.quotes.get(quoteId);
    return q && q.org_id === orgId && q.case_id === caseId ? q : null;
  }

  async insertOffer(record: Omit<OfferRecord, "id">) {
    const row = {
      ...record,
      id: (record as OfferRecord).id ?? randomUUID(),
    };
    this.offers.set(row.id, row);
    return row;
  }

  async insertQuote(record: Omit<QuoteRecord, "id">) {
    const row = {
      ...record,
      id: (record as QuoteRecord).id ?? randomUUID(),
    };
    this.quotes.set(row.id, row);
    return row;
  }

  async listActions(orgId: string, caseId: string) {
    return [...this.actions.values()].filter(
      (a) => a.org_id === orgId && a.case_id === caseId,
    );
  }

  async getAction(orgId: string, caseId: string, actionId: string) {
    const a = this.actions.get(actionId);
    return a && a.org_id === orgId && a.case_id === caseId ? a : null;
  }

  async prepareAction(input: PrepareActionInput): Promise<PreparedActionResult> {
    const existing = [...this.actions.values()].find(
      (a) => a.org_id === input.orgId && a.idempotency_key === input.idempotencyKey,
    );
    if (existing) return { action: existing, created: false };
    const row: ActionRecord = {
      id: randomUUID(),
      org_id: input.orgId,
      case_id: input.caseId,
      kind: input.kind,
      state: "prepared",
      payload: input.payload,
      payload_hash: sha256Hex(canonicalJson(input.payload)),
      idempotency_key: input.idempotencyKey,
      mode: input.mode,
      created_at: new Date(0).toISOString(),
    };
    this.actions.set(row.id, row);
    return { action: row, created: true };
  }

  async updateActionState(
    orgId: string,
    caseId: string,
    actionId: string,
    state: ActionState,
  ) {
    const a = await this.getAction(orgId, caseId, actionId);
    if (a) a.state = state;
  }

  async getEvidence(orgId: string, evidenceId: string) {
    return this.scoped(this.evidence, orgId, evidenceId);
  }

  async findCaseEvidence(
    orgId: string,
    caseId: string,
    evidenceId: string,
    purpose?: string,
  ) {
    return (
      this.caseEvidence.find(
        (l) =>
          l.org_id === orgId &&
          l.case_id === caseId &&
          l.evidence_id === evidenceId &&
          (purpose === undefined || l.purpose === purpose),
      ) ?? null
    );
  }

  async listCaseEvidence(orgId: string, caseId: string) {
    const ids = this.caseEvidence
      .filter((l) => l.org_id === orgId && l.case_id === caseId)
      .map((l) => l.evidence_id);
    return ids
      .map((id) => this.evidence.get(id))
      .filter((e): e is EvidenceRecord => Boolean(e && e.org_id === orgId));
  }

  async insertEvidence(record: Omit<EvidenceRecord, "id">) {
    const row = { ...record, id: randomUUID() };
    this.evidence.set(row.id, row);
    return row;
  }

  async linkCaseEvidence(link: CaseEvidenceLink) {
    if (
      !this.caseEvidence.some(
        (l) =>
          l.org_id === link.org_id &&
          l.case_id === link.case_id &&
          l.evidence_id === link.evidence_id &&
          l.purpose === link.purpose,
      )
    ) {
      this.caseEvidence.push(link);
    }
  }

  async insertResearchQuery(record: Omit<ResearchQueryRecord, "id" | "created_at">) {
    const row = { ...record, id: randomUUID() };
    this.researchQueries.set(row.id, row);
    return row;
  }

  async countResearchQueries(orgId: string, caseId: string, episode: number) {
    return [...this.researchQueries.values()].filter(
      (q) => q.org_id === orgId && q.case_id === caseId && q.episode === episode,
    ).length;
  }

  async insertSupplierCandidate(record: Omit<SupplierCandidateRecord, "id">) {
    const row = { ...record, id: randomUUID() };
    return row;
  }

  async countPageReads(orgId: string, caseId: string, episode: number) {
    const keys = new Set(
      this.pageReads
        .filter(
          (p) => p.org_id === orgId && p.case_id === caseId && p.episode === episode,
        )
        .map((p) => p.evidence_id),
    );
    return keys.size;
  }

  async hasPageRead(
    orgId: string,
    caseId: string,
    episode: number,
    evidenceId: string,
  ) {
    return this.pageReads.some(
      (p) =>
        p.org_id === orgId &&
        p.case_id === caseId &&
        p.episode === episode &&
        p.evidence_id === evidenceId,
    );
  }

  async insertPageRead(
    orgId: string,
    caseId: string,
    episode: number,
    evidenceId: string,
  ) {
    const exists = this.pageReads.some(
      (p) =>
        p.org_id === orgId &&
        p.case_id === caseId &&
        p.episode === episode &&
        p.evidence_id === evidenceId,
    );
    if (!exists) {
      this.pageReads.push({
        org_id: orgId,
        case_id: caseId,
        episode,
        evidence_id: evidenceId,
      });
    }
  }

  async insertReview(record: Omit<PlannerReviewRecord, "id">) {
    const row = { ...record, id: randomUUID() };
    this.reviews.set(row.id, row);
    return row;
  }

  async insertWait(record: Omit<PlannerWaitRecord, "id">) {
    const row = { ...record, id: randomUUID() };
    this.waits.set(row.id, row);
    return row;
  }

  async listWaits(orgId: string, caseId: string) {
    return [...this.waits.values()].filter(
      (w) => w.org_id === orgId && w.case_id === caseId,
    );
  }

  async updateWaitStatus(
    orgId: string,
    caseId: string,
    waitId: string,
    status: PlannerWaitRecord["status"],
  ) {
    const w = this.waits.get(waitId);
    if (w && w.org_id === orgId && w.case_id === caseId) w.status = status;
  }

  async findSatisfiedWait(
    orgId: string,
    caseId: string,
    wait: PlannerWaitRecord,
  ): Promise<boolean> {
    if (wait.expected_kind === "supplier_response") {
      return this.caseEvidence.some(
        (l) =>
          l.org_id === orgId &&
          l.case_id === caseId &&
          l.purpose === "supplier_response" &&
          (this.evidence.get(l.evidence_id)?.captured_at ?? "") >= wait.created_at,
      );
    }
    if (wait.expected_kind === "call_result") {
      if (!wait.action_id) return false;
      const session = [...this.callSessions.values()].find(
        (s) => s.org_id === orgId && s.action_id === wait.action_id && s.ended_at,
      );
      return Boolean(session);
    }
    // action_outcome: the action reached a resolved state
    if (!wait.action_id) return false;
    const action = await this.getAction(orgId, caseId, wait.action_id);
    return Boolean(
      action && !["prepared", "dispatching"].includes(action.state),
    );
  }

  async insertCycle(record: PlannerCycleRecord) {
    const existing = this.cycles.get(record.id);
    if (existing) return existing;
    this.cycles.set(record.id, record);
    return record;
  }

  async updateCycle(orgId: string, cycleId: string, patch: Partial<PlannerCycleRecord>) {
    const c = this.cycles.get(cycleId);
    if (c && c.org_id === orgId) Object.assign(c, patch);
  }

  async insertPlannerRequest(record: Omit<PlannerRequestRecord, "id">) {
    const row = { ...record, id: randomUUID() };
    this.requests.set(row.id, row);
    return row;
  }

  async countPlannerRequests(
    orgId: string,
    caseId: string,
    episode: number,
    cycleId?: string,
  ) {
    return [...this.requests.values()].filter(
      (r) =>
        r.org_id === orgId &&
        r.case_id === caseId &&
        r.episode === episode &&
        (cycleId === undefined || r.cycle_id === cycleId),
    ).length;
  }

  async insertUsageEvent(input: UsageEventInput) {
    this.usageEvents.push(input);
  }

  async getCurrentPolicy(orgId: string) {
    const sorted = this.policies
      .filter((p) => p.org_id === orgId)
      .sort((a, b) => b.version - a.version);
    return sorted[0] ?? null;
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
    steps: (PlanStepInsert & { item_id: string; unit: string; missing_fields: string[] })[];
  }): Promise<RecoveryPlanRecord> {
    const row: RecoveryPlanRecord = {
      id: randomUUID(),
      org_id: input.orgId,
      case_id: input.caseId,
      version: input.version,
      assessment_id: input.assessmentId,
      status: input.status,
      gross_commitment_minor: input.grossCommitmentMinor,
      incremental_cost_minor: input.incrementalCostMinor,
      evidence_ids: input.evidenceIds,
    };
    this.plans.set(row.id, row);
    for (const step of input.steps) {
      this.planSteps.push({ ...step, plan_id: row.id });
    }
    return row;
  }

  async nextPlanVersion(orgId: string, caseId: string) {
    const versions = [...this.plans.values()]
      .filter((p) => p.org_id === orgId && p.case_id === caseId)
      .map((p) => p.version);
    return versions.length ? Math.max(...versions) + 1 : 1;
  }

  async getCallSessionForAction(orgId: string, actionId: string) {
    return (
      [...this.callSessions.values()].find(
        (s) => s.org_id === orgId && s.action_id === actionId,
      ) ?? null
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async loadProjectionInput(_orgId: string, _caseId: string): Promise<ProjectionInput> {
    if (!this.projectionInput) throw new Error("no projection input seeded");
    return this.projectionInput;
  }

  async insertAudit(entry: {
    org_id: string;
    case_id?: string | null;
    actor_type: string;
    entity_type: string;
    entity_id?: string | null;
    event_name: string;
    reason?: string | null;
  }) {
    this.audits.push(entry);
  }
}
