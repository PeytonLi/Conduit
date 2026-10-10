import type { CallOutcome, CallToolSummary, NormalizedCallOutcome, ProcurementResult } from "@/lib/integrations/elevenlabs/outcomes";

/** Persistence seam for F4 voice. The Supabase implementation calls the voice_* SQL functions. */

export interface VoiceOrderLineFact {
  po_ref: string;
  line_ref: string | null;
  remaining_qty: number;
  original_due_at: string | null;
}

export interface VoiceCaseFacts {
  org_name: string;
  org_timezone: string;
  item_sku: string;
  item_description: string;
  unit: string;
  destination: string;
  supplier_name: string;
  contact_name: string | null;
  bridge_qty: number | null;
  first_shortage_at: string | null;
  dated_requirements: unknown;
  assessment_version: number | null;
  order_lines: VoiceOrderLineFact[];
}

export type RunControl = "active" | "paused" | "blocked";

export interface VoiceCallContext {
  org_name: string;
  org_timezone: string;
  org_currency: string;
  org_mode: "replay" | "sandbox" | "live";
  case_id: string;
  case_phase: string;
  run_control: RunControl;
  action_state: string;
  contact_id: string;
  contact_channel: "email" | "phone";
  contact_phone: string;
  contact_name: string | null;
  contact_timezone: string | null;
  contact_phone_permitted: boolean;
  supplier_id: string;
  supplier_name: string;
  existing_call_session: boolean;
  other_calls_in_flight: number;
  facts: VoiceCaseFacts;
}

export interface VoiceGrantResolution {
  grant_id: string;
  org_id: string;
  action_id: string;
  case_id: string;
  contact_id: string;
  allowed_tools: string[];
  expires_at: string;
  revoked_at: string | null;
  run_control: RunControl;
  case_phase: string;
  action_state: string;
  conversation_id: string | null;
}

export interface VoiceOfferContext {
  org_currency: string;
  negotiation_ceiling_minor: string | null;
  timezone: string;
  unit: string;
  bridge_qty: number | null;
  first_shortage_at: string | null;
  original_unit_price_minor: string | null;
}

export type OwnerTaskKind = "above_ceiling" | "human_review" | "ceiling_not_configured" | "written_confirmation";

export interface ProvisionalOfferInput {
  org_id: string;
  case_id: string;
  action_id: string;
  contact_id: string;
  conversation_id: string | null;
  recorded_at: string;
  content_hash: string;
  excerpt: string;
  quantity: number;
  unit: string;
  unit_price_minor: string | null;
  currency: string;
  freight_minor: string | null;
  fees_minor: string | null;
  arrival_by: string | null;
  valid_until: string | null;
  order_cutoff: string | null;
  added_cost_minor: string | null;
  owner_task_kind: OwnerTaskKind | null;
  owner_task_reason: string | null;
}

export interface ProvisionalOfferResult {
  offer_id: string;
  quote_id: string;
  evidence_id: string;
  owner_task_id: string | null;
}

export interface CallbackLink extends CallToolSummary {
  org_id: string;
  action_id: string;
  case_id: string;
}

export interface CallbackRecordInput {
  provider: "elevenlabs" | "voice_bridge";
  external_event_key: string;
  conversation_id: string;
  event_type: string;
  payload_hash: string;
  payload: unknown;
  received_at: string;
  action_hint: string | null;
  outcome: NormalizedCallOutcome;
  excerpt: string | null;
  provider_call_id: string | null;
  duration_seconds: number | null;
}

export type CallbackRecordResult =
  | { status: "recorded"; receipt_id: string; org_id: string; action_id: string; case_id: string }
  | { status: "duplicate"; receipt_id: string; payload_matches: boolean }
  | { status: "quarantined" };

export interface StoredCallOutcome {
  outcome: CallOutcome;
  conversation_id: string;
  provider_status: string | null;
  transport_completed: boolean;
  procurement_result: ProcurementResult;
}

export interface StoredCallSession {
  conversation_id: string | null;
  provider_call_id: string | null;
  created_at: string;
}

export interface VoiceStore {
  callContext(orgId: string, actionId: string, contactId: string): Promise<VoiceCallContext | null>;
  prepareCall(input: {
    orgId: string;
    actionId: string;
    caseId: string;
    contactId: string;
    tokenHash: string;
    allowedTools: readonly string[];
    expiresAt: Date;
  }): Promise<{ status: "prepared" | "already_attempted" | "not_found" }>;
  markCallStarted(orgId: string, actionId: string, conversationId: string | null, sipCallId: string | null, at: Date): Promise<void>;
  revokeGrants(orgId: string, actionId: string, at: Date): Promise<void>;
  resolveGrant(tokenHash: string): Promise<VoiceGrantResolution | null>;
  caseFacts(orgId: string, caseId: string, contactId: string): Promise<VoiceCaseFacts | null>;
  offerContext(orgId: string, caseId: string, contactId: string): Promise<VoiceOfferContext | null>;
  recordToolEvent(input: {
    orgId: string;
    caseId: string;
    actionId: string;
    tool: string;
    resultCode: string;
    payload: Record<string, unknown>;
    at: Date;
  }): Promise<void>;
  createOwnerTask(input: {
    orgId: string;
    caseId: string;
    actionId: string;
    kind: OwnerTaskKind;
    reason: string;
    detail: Record<string, unknown>;
    at: Date;
  }): Promise<string>;
  recordProvisionalOffer(input: ProvisionalOfferInput): Promise<ProvisionalOfferResult>;
  callbackLink(conversationId: string, actionHint: string | null): Promise<CallbackLink | null>;
  recordCallback(input: CallbackRecordInput): Promise<CallbackRecordResult>;
  callOutcome(orgId: string, actionId: string): Promise<StoredCallOutcome | null>;
  callSession(orgId: string, actionId: string): Promise<StoredCallSession | null>;
  flagStaleCalls(now: Date, graceSeconds: number): Promise<number>;
}
