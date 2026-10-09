import type { ActionKind, ActionRecord, DispatchResult, ReconcileResult } from "./types";
import { callLedger, type Clock, type LedgerResult, type Rpc } from "./rpc";

export type ActionState =
  | "prepared"
  | "dispatching"
  | "submitted"
  | "confirmed"
  | "failed"
  | "unknown"
  | "cancelled";

export interface LedgerAction {
  id: string;
  org_id: string;
  case_id: string;
  plan_id: string | null;
  plan_step_id: string | null;
  approval_id: string | null;
  contact_id: string | null;
  kind: ActionKind;
  state: ActionState;
  payload_hash: string;
  payload: unknown;
  idempotency_key: string;
  provider: string | null;
  provider_ref: string | null;
  attempts: number;
  dispatch_started_at: string | null;
  next_reconcile_at: string | null;
  outcome: { safe_summary?: string; source?: string; evidence_id?: string | null } | null;
  error_code: string | null;
  mode: "replay" | "sandbox" | "live";
  episode: number | null;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface ActionClaim {
  id: string;
  state: "active" | "consumed" | "released" | "uncertain";
  quantity: number;
  receipt_schedule_ids: string[];
  demand_ids: string[];
}

export interface Ledger {
  rpc: Rpc;
  clock: Clock;
}

export interface PrepareActionInput {
  orgId: string;
  actor: { type: "user" | "system"; id: string };
  caseId: string;
  kind: ActionKind;
  payload: unknown;
  idempotencyKey: string;
  contactId?: string | null;
  planId?: string | null;
  planStepId?: string | null;
  approvalId?: string | null;
}

export const terminalStates: readonly ActionState[] = ["confirmed", "failed", "cancelled"];

export function toActionRecord(action: LedgerAction): ActionRecord {
  return {
    id: action.id,
    orgId: action.org_id,
    caseId: action.case_id,
    kind: action.kind,
    idempotencyKey: action.idempotency_key,
    payloadHash: action.payload_hash,
    payload: action.payload,
    contactId: action.contact_id,
    providerRef: action.provider_ref,
    mode: action.mode,
  };
}

const now = (ledger: Ledger) => ledger.clock.now().toISOString();

export function prepareAction(ledger: Ledger, input: PrepareActionInput) {
  return callLedger<{ replayed: boolean; action: LedgerAction }>(ledger.rpc, "ledger_prepare_action", {
    p_org_id: input.orgId,
    p_actor_type: input.actor.type,
    p_actor_id: input.actor.id,
    p_case_id: input.caseId,
    p_kind: input.kind,
    p_payload: input.payload,
    p_idempotency_key: input.idempotencyKey,
    p_contact_id: input.contactId ?? null,
    p_plan_id: input.planId ?? null,
    p_plan_step_id: input.planStepId ?? null,
    p_approval_id: input.approvalId ?? null,
    p_now: now(ledger),
  });
}

export function claimDispatch(ledger: Ledger, orgId: string, actionId: string, leaseSeconds: number) {
  return callLedger<{ action: LedgerAction }>(ledger.rpc, "ledger_claim_dispatch", {
    p_org_id: orgId,
    p_action_id: actionId,
    p_lease_seconds: leaseSeconds,
    p_now: now(ledger),
  });
}

export function recordOutcome(
  ledger: Ledger,
  orgId: string,
  actionId: string,
  result: DispatchResult | ReconcileResult | { outcome: "cancelled"; safeSummary: string; providerRef?: string },
  source: "dispatch" | "reconcile" | "callback" | "control",
  errorCode: string | null = null,
) {
  return callLedger<{ duplicate: boolean; action: LedgerAction }>(ledger.rpc, "ledger_record_outcome", {
    p_org_id: orgId,
    p_action_id: actionId,
    p_outcome: result.outcome,
    p_provider_ref: result.providerRef ?? null,
    p_safe_summary: result.safeSummary,
    p_error_code: errorCode,
    p_source: source,
    p_actor_id: source,
    p_evidence_id: null,
    p_now: now(ledger),
  });
}

export function getAction(
  ledger: Ledger,
  orgId: string,
  actionId: string,
): Promise<LedgerResult<{ action: LedgerAction; claims: ActionClaim[]; approval: unknown }>> {
  return callLedger(ledger.rpc, "ledger_get_action", { p_org_id: orgId, p_action_id: actionId });
}

export function resolveAction(
  ledger: Ledger,
  input: { orgId: string; actionId: string; userId: string; outcome: "confirmed" | "failed"; evidenceId: string; note?: string },
) {
  return callLedger<{ duplicate: boolean; action: LedgerAction }>(ledger.rpc, "ledger_resolve_action", {
    p_org_id: input.orgId,
    p_action_id: input.actionId,
    p_actor_user_id: input.userId,
    p_outcome: input.outcome,
    p_evidence_id: input.evidenceId,
    p_note: input.note ?? null,
    p_now: now(ledger),
  });
}
