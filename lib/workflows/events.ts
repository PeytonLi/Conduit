import type { EventName } from "@/lib/schemas/events";
import type { InternalEventEnvelope } from "@/lib/schemas/events";

export interface ConduitEventMap {
  "supplier.message.received": { message_id: string };
  "case.assessment.requested": { case_id: string; source_version: number };
  "business.snapshot.activated": { dataset_id: string };
  "case.recovery.requested": { case_id: string; assessment_version: number };
  "supplier.response.recorded": { case_id: string; evidence_id: string };
  "supplier.call.finished": {
    case_id: string;
    action_id: string;
    conversation_id: string;
  };
  "plan.approved": { case_id: string; plan_id: string; approval_id: string };
  "action.reconcile.requested": { action_id: string };
  "action.outcome.recorded": { action_id: string; outcome_version: number };
  "receipt.recorded": { po_line_id: string; receipt_event_id: string };
  "case.control.changed": { case_id: string; version: number };
  "policy.changed": { policy_version_id: string };
}

export type ConduitEvent = {
  [Name in EventName]: Omit<InternalEventEnvelope, "name" | "data"> & {
    name: Name;
    data: ConduitEventMap[Name];
  };
}[EventName];

/** Insert into event_outbox inside the caller's transaction. */
export async function publishOutbox(_tx: unknown, _event: ConduitEvent): Promise<void> {
  void _tx;
  void _event;
  throw new Error("not implemented");
}
