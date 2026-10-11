import { describe, expect, it, vi } from "vitest";
import {
  reassessFinishedSupplierCall,
  type FinishedSupplierCall,
} from "@/lib/domain/supplier-call-reassess";
import type { StoredCallOutcome } from "@/lib/db/voice-store";

const event: FinishedSupplierCall = {
  org_id: "00000000-0000-4000-8000-000000000001",
  case_id: "00000000-0000-4000-8000-000000000002",
  action_id: "00000000-0000-4000-8000-000000000003",
  event_id: "00000000-0000-4000-8000-000000000004",
};

function outcome(
  overrides: Partial<StoredCallOutcome> = {},
): StoredCallOutcome {
  return {
    outcome: "answered_with_offer",
    conversation_id: "conversation",
    provider_status: "done",
    transport_completed: true,
    procurement_result: "provisional_offer",
    ...overrides,
  };
}

function deps(options: {
  permittedBy?: string | null;
  outcome?: StoredCallOutcome | null;
  caseId?: string;
} = {}) {
  const requestReassessment = vi.fn(async () => undefined);
  return {
    requestReassessment,
    deps: {
      loadAction: vi.fn(async () => ({
        case_id: options.caseId ?? event.case_id,
        permitted_by: options.permittedBy === undefined ? "owner-id" : options.permittedBy,
      })),
      loadOutcome: vi.fn(async () => options.outcome === undefined ? outcome() : options.outcome),
      requestReassessment,
    },
  };
}

describe("supplier-call reassessment workflow", () => {
  it("does not request reassessment for a planner-dispatched call", async () => {
    const test = deps({ permittedBy: null });
    await expect(reassessFinishedSupplierCall(test.deps, event)).resolves.toEqual({ status: "planner_call" });
    expect(test.deps.loadOutcome).not.toHaveBeenCalled();
    expect(test.requestReassessment).not.toHaveBeenCalled();
  });

  it("does not request reassessment when a call has no answer", async () => {
    const test = deps({
      outcome: outcome({ outcome: "no_answer", procurement_result: "not_reached" }),
    });
    await expect(reassessFinishedSupplierCall(test.deps, event)).resolves.toEqual({ status: "no_offer" });
    expect(test.requestReassessment).not.toHaveBeenCalled();
  });

  it("does not request reassessment when an answered call has no offer", async () => {
    const test = deps({
      outcome: outcome({ outcome: "answered_no_solution", procurement_result: "no_offer" }),
    });
    await expect(reassessFinishedSupplierCall(test.deps, event)).resolves.toEqual({ status: "no_offer" });
    expect(test.requestReassessment).not.toHaveBeenCalled();
  });

  it("requests reassessment once for a manual call with an offer, using the source event id", async () => {
    const test = deps();
    await expect(reassessFinishedSupplierCall(test.deps, event)).resolves.toEqual({ status: "requested" });
    expect(test.requestReassessment).toHaveBeenCalledTimes(1);
    expect(test.requestReassessment).toHaveBeenCalledWith({
      ...event,
      outcome: "answered_with_offer",
    });
  });
});
