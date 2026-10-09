import type {
  CallbackLink,
  CallbackRecordInput,
  CallbackRecordResult,
  ProvisionalOfferInput,
  RunControl,
  StoredCallOutcome,
  VoiceCallContext,
  VoiceCaseFacts,
  VoiceGrantResolution,
  VoiceOfferContext,
  VoiceStore,
} from "@/lib/db/voice-store";

export const ORG_A = "00000000-0000-4000-8000-000000000001";
export const ORG_B = "00000000-0000-4000-8000-000000000002";
export const CASE_A = "40000000-0000-4000-8000-000000000001";
export const CASE_B = "40000000-0000-4000-8000-000000000002";
export const CONTACT_A = "50000000-0000-4000-8000-000000000001";
export const CONTACT_B = "50000000-0000-4000-8000-000000000002";
export const ACTION_A = "60000000-0000-4000-8000-000000000001";
export const ACTION_B = "60000000-0000-4000-8000-000000000002";

export function fakeClock(start = "2026-10-12T17:00:00.000Z") {
  let current = new Date(start).getTime();
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

export function factsFor(org: "A" | "B"): VoiceCaseFacts {
  return {
    org_name: org === "A" ? "Harbor Pack" : "Other Co",
    org_timezone: "America/Los_Angeles",
    item_sku: org === "A" ? "BOX-12" : "SECRET-B",
    item_description: org === "A" ? "12in shipping box" : "Other Co confidential item",
    unit: "each",
    destination: org === "A" ? "Oakland DC" : "Other DC",
    supplier_name: org === "A" ? "Acme Corrugated" : "Other Supplier",
    contact_name: "Dana",
    bridge_qty: 400,
    first_shortage_at: "2026-10-20T15:00:00.000Z",
    dated_requirements: [],
    assessment_version: 1,
    order_lines: [{ po_ref: org === "A" ? "PO-1001" : "PO-B-9", line_ref: "1", remaining_qty: 1000, original_due_at: null }],
  };
}

interface FakeCase {
  org_id: string;
  run_control: RunControl;
  phase: string;
}

interface StoredGrant {
  hash: string;
  org_id: string;
  action_id: string;
  case_id: string;
  contact_id: string;
  allowed_tools: string[];
  expires_at: Date;
  revoked_at: Date | null;
}

/** In-memory VoiceStore mirroring the voice_* SQL function semantics. */
export function createFakeVoiceStore() {
  const cases = new Map<string, FakeCase>([
    [CASE_A, { org_id: ORG_A, run_control: "active", phase: "awaiting_supplier" }],
    [CASE_B, { org_id: ORG_B, run_control: "active", phase: "awaiting_supplier" }],
  ]);
  const actions = new Map<string, { org_id: string; case_id: string; contact_id: string; state: string }>([
    [ACTION_A, { org_id: ORG_A, case_id: CASE_A, contact_id: CONTACT_A, state: "dispatching" }],
    [ACTION_B, { org_id: ORG_B, case_id: CASE_B, contact_id: CONTACT_B, state: "dispatching" }],
  ]);
  const grants: StoredGrant[] = [];
  const sessions = new Map<string, { org_id: string; conversation_id: string | null; sip_call_id: string | null; created_at: string; ended_at: string | null }>();
  const toolEvents: { orgId: string; caseId: string; tool: string; resultCode: string; payload: Record<string, unknown> }[] = [];
  const ownerTasks: { orgId: string; caseId: string; kind: string; reason: string }[] = [];
  const quotes: (ProvisionalOfferInput & { quote_id: string; status: "provisional" })[] = [];
  const receipts = new Map<string, { id: string; payload_hash: string; retries: number }>();
  const quarantine: CallbackRecordInput[] = [];
  const outcomes = new Map<string, StoredCallOutcome>();
  const outbox: { event_type: string; payload: Record<string, string> }[] = [];
  const offerContexts = new Map<string, VoiceOfferContext>([
    [CASE_A, { org_currency: "USD", negotiation_ceiling_minor: "50000", timezone: "America/Los_Angeles", unit: "each", bridge_qty: 400, first_shortage_at: "2026-10-20T15:00:00.000Z", original_unit_price_minor: "120" }],
    [CASE_B, { org_currency: "USD", negotiation_ceiling_minor: "999999999", timezone: "America/Los_Angeles", unit: "each", bridge_qty: 10, first_shortage_at: "2026-10-20T15:00:00.000Z", original_unit_price_minor: "100" }],
  ]);
  const contactPermitted = new Map<string, boolean>([[CONTACT_A, true], [CONTACT_B, true]]);
  let otherCallsInFlight = 0;
  let seq = 0;
  const id = (prefix: string) => `${prefix}-${++seq}`;

  const toolSummary = (actionId: string) => ({
    offer_recorded: toolEvents.some((e) => e.tool === "record_provisional_offer" && e.resultCode === "recorded" && actions.get(actionId)?.case_id === e.caseId),
    human_review_requested: toolEvents.some((e) => e.tool === "request_human_review" && actions.get(actionId)?.case_id === e.caseId),
    end_call_logged: toolEvents.some((e) => e.tool === "end_call" && actions.get(actionId)?.case_id === e.caseId),
  });

  const findSession = (conversationId: string, hint: string | null): string | null => {
    for (const [actionId, session] of sessions) if (session.conversation_id === conversationId) return actionId;
    if (hint && sessions.has(hint) && sessions.get(hint)!.conversation_id === null) return hint;
    return null;
  };

  const store: VoiceStore = {
    async callContext(orgId, actionId, contactId): Promise<VoiceCallContext | null> {
      const action = actions.get(actionId);
      if (!action || action.org_id !== orgId || action.contact_id !== contactId) return null;
      const kase = cases.get(action.case_id)!;
      const isA = orgId === ORG_A;
      return {
        org_name: isA ? "Harbor Pack" : "Other Co",
        org_timezone: "America/Los_Angeles",
        org_currency: "USD",
        org_mode: "sandbox",
        case_id: action.case_id,
        case_phase: kase.phase,
        run_control: kase.run_control,
        action_state: action.state,
        contact_id: contactId,
        contact_channel: "phone",
        contact_phone: "+15555550100",
        contact_name: "Dana",
        contact_timezone: null,
        contact_phone_permitted: contactPermitted.get(contactId) ?? false,
        supplier_id: "supplier",
        supplier_name: isA ? "Acme Corrugated" : "Other Supplier",
        existing_call_session: sessions.has(actionId),
        other_calls_in_flight: otherCallsInFlight,
        facts: factsFor(isA ? "A" : "B"),
      };
    },
    async prepareCall(i) {
      const action = actions.get(i.actionId);
      if (!action || action.org_id !== i.orgId) return { status: "not_found" };
      if (sessions.has(i.actionId)) return { status: "already_attempted" };
      grants.push({ hash: i.tokenHash, org_id: i.orgId, action_id: i.actionId, case_id: i.caseId, contact_id: i.contactId, allowed_tools: [...i.allowedTools], expires_at: i.expiresAt, revoked_at: null });
      sessions.set(i.actionId, { org_id: i.orgId, conversation_id: null, sip_call_id: null, created_at: new Date(0).toISOString(), ended_at: null });
      return { status: "prepared" };
    },
    async markCallStarted(_orgId, actionId, conversationId, sipCallId) {
      const session = sessions.get(actionId);
      if (session) {
        session.conversation_id ??= conversationId;
        session.sip_call_id ??= sipCallId;
      }
    },
    async revokeGrants(_orgId, actionId, at) {
      for (const grant of grants) if (grant.action_id === actionId) grant.revoked_at ??= at;
    },
    async resolveGrant(tokenHash): Promise<VoiceGrantResolution | null> {
      const grant = grants.find((g) => g.hash === tokenHash);
      if (!grant) return null;
      const kase = cases.get(grant.case_id)!;
      return {
        grant_id: grant.hash.slice(0, 8),
        org_id: grant.org_id,
        action_id: grant.action_id,
        case_id: grant.case_id,
        contact_id: grant.contact_id,
        allowed_tools: grant.allowed_tools,
        expires_at: grant.expires_at.toISOString(),
        revoked_at: grant.revoked_at?.toISOString() ?? null,
        run_control: kase.run_control,
        case_phase: kase.phase,
        action_state: actions.get(grant.action_id)!.state,
        conversation_id: sessions.get(grant.action_id)?.conversation_id ?? null,
      };
    },
    async caseFacts(orgId, caseId) {
      const kase = cases.get(caseId);
      if (!kase || kase.org_id !== orgId) return null;
      return factsFor(orgId === ORG_A ? "A" : "B");
    },
    async offerContext(orgId, caseId) {
      const kase = cases.get(caseId);
      if (!kase || kase.org_id !== orgId) return null;
      return offerContexts.get(caseId) ?? null;
    },
    async recordToolEvent(i) {
      toolEvents.push({ orgId: i.orgId, caseId: i.caseId, tool: i.tool, resultCode: i.resultCode, payload: i.payload });
    },
    async createOwnerTask(i) {
      ownerTasks.push({ orgId: i.orgId, caseId: i.caseId, kind: i.kind, reason: i.reason });
      return id("task");
    },
    async recordProvisionalOffer(input) {
      const quoteId = id("quote");
      quotes.push({ ...input, quote_id: quoteId, status: "provisional" });
      let taskId: string | null = null;
      if (input.owner_task_kind) {
        taskId = id("task");
        ownerTasks.push({ orgId: input.org_id, caseId: input.case_id, kind: input.owner_task_kind, reason: input.owner_task_reason ?? "" });
      }
      toolEvents.push({ orgId: input.org_id, caseId: input.case_id, tool: "record_provisional_offer", resultCode: "recorded", payload: { quote_id: quoteId } });
      return { offer_id: id("offer"), quote_id: quoteId, evidence_id: id("evidence"), owner_task_id: taskId };
    },
    async callbackLink(conversationId, hint): Promise<CallbackLink | null> {
      const actionId = findSession(conversationId, hint);
      if (!actionId) return null;
      const action = actions.get(actionId)!;
      return { org_id: action.org_id, action_id: actionId, case_id: action.case_id, ...toolSummary(actionId) };
    },
    async recordCallback(input): Promise<CallbackRecordResult> {
      const key = `${input.provider}:${input.external_event_key}`;
      const existing = receipts.get(key);
      if (existing) {
        existing.retries += 1;
        return { status: "duplicate", receipt_id: existing.id, payload_matches: existing.payload_hash === input.payload_hash };
      }
      const actionId = findSession(input.conversation_id, input.action_hint);
      if (!actionId) {
        quarantine.push(input);
        return { status: "quarantined" };
      }
      const action = actions.get(actionId)!;
      const receiptId = id("receipt");
      receipts.set(key, { id: receiptId, payload_hash: input.payload_hash, retries: 0 });
      const session = sessions.get(actionId)!;
      session.conversation_id ??= input.conversation_id;
      session.ended_at ??= input.received_at;
      if (!outcomes.has(actionId)) {
        outcomes.set(actionId, {
          outcome: input.outcome.outcome,
          conversation_id: input.conversation_id,
          provider_status: input.outcome.provider_status,
          transport_completed: input.outcome.transport_completed,
          procurement_result: input.outcome.procurement_result,
        });
      }
      if (["dispatching", "submitted", "unknown"].includes(action.state)) action.state = "confirmed";
      for (const grant of grants) if (grant.action_id === actionId) grant.revoked_at ??= new Date(input.received_at);
      outbox.push({ event_type: "supplier.call.finished", payload: { case_id: action.case_id, action_id: actionId, conversation_id: input.conversation_id } });
      return { status: "recorded", receipt_id: receiptId, org_id: action.org_id, action_id: actionId, case_id: action.case_id };
    },
    async callOutcome(_orgId, actionId) {
      return outcomes.get(actionId) ?? null;
    },
    async callSession(_orgId, actionId) {
      const session = sessions.get(actionId);
      return session ? { conversation_id: session.conversation_id, provider_call_id: session.sip_call_id, created_at: session.created_at } : null;
    },
    async flagStaleCalls() {
      return 0;
    },
  };

  return {
    store,
    cases,
    actions,
    grants,
    sessions,
    toolEvents,
    ownerTasks,
    quotes,
    receipts,
    quarantine,
    outbox,
    offerContexts,
    contactPermitted,
    setOtherCallsInFlight: (n: number) => {
      otherCallsInFlight = n;
    },
  };
}
