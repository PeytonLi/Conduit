import type { StoredCallOutcome } from "@/lib/db/voice-store";

export interface FinishedSupplierCall {
  org_id: string;
  case_id: string;
  action_id: string;
  event_id: string;
}

export interface SupplierCallReassessDeps {
  loadAction(orgId: string, actionId: string): Promise<{
    case_id: string;
    permitted_by: string | null;
  } | null>;
  loadOutcome(orgId: string, actionId: string): Promise<StoredCallOutcome | null>;
  requestReassessment(input: FinishedSupplierCall & { outcome: string }): Promise<unknown>;
}

export async function reassessFinishedSupplierCall(
  deps: SupplierCallReassessDeps,
  event: FinishedSupplierCall,
): Promise<{ status: string }> {
  const action = await deps.loadAction(event.org_id, event.action_id);
  if (!action || action.case_id !== event.case_id) return { status: "action_not_found" };
  if (action.permitted_by === null) return { status: "planner_call" };

  const outcome = await deps.loadOutcome(event.org_id, event.action_id);
  if (
    !outcome ||
    (outcome.procurement_result !== "provisional_offer" && outcome.outcome !== "answered_with_offer")
  ) {
    return { status: "no_offer" };
  }

  await deps.requestReassessment({ ...event, outcome: outcome.outcome });
  return { status: "requested" };
}
