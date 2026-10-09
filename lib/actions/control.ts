import { callLedger, type Clock, type Rpc } from "./rpc";

export type CaseControlCommand = "pause" | "resume" | "cancel";

export interface CaseControlEffects {
  command: CaseControlCommand;
  /** Prepared actions that will not dispatch while the case is paused. */
  held_action_ids: string[];
  /** Prepared actions cancelled before dispatch (claims released, approvals revoked). */
  cancelled_action_ids: string[];
  /** On resume, held actions were re-queued for dispatch. */
  requeued: boolean;
  /** Dispatching/submitted/unknown actions: never rewritten locally; they still need reconciliation. */
  requires_reconciliation_action_ids: string[];
}

/**
 * Dispatch-side effects of POST /api/v1/cases/:id/control (owned by F6). Call after the case's
 * run_control has been updated in the same request. The dispatcher re-checks run_control at
 * claim time, so a paused case can never start a new provider call.
 */
export function applyCaseControlEffects(
  deps: { rpc: Rpc; clock: Clock },
  input: { orgId: string; caseId: string; command: CaseControlCommand; actorUserId: string },
) {
  return callLedger<CaseControlEffects>(deps.rpc, "case_control_effects", {
    p_org_id: input.orgId,
    p_case_id: input.caseId,
    p_command: input.command,
    p_actor_id: input.actorUserId,
    p_now: deps.clock.now().toISOString(),
  });
}
