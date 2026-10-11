import { describe, expect, it } from "vitest";
import { humanLabel, phaseStage } from "@/lib/ui/labels";
import { CALL_OUTCOMES } from "@/lib/integrations/elevenlabs/outcomes";
import type { CasePhase } from "@/lib/schemas/enums";

describe("UI labels", () => {
  it("provides plain-language call outcome and quote-term labels", () => {
    expect(humanLabel("callOutcome", "answered_with_offer")).toBe("Answered with an offer");
    expect(humanLabel("callOutcome", "no_answer")).toBe("No answer");
    expect(humanLabel("missingQuoteTerm", "nonrecoverable_tax")).toBe("Non-recoverable tax");
    expect(humanLabel("missingQuoteTerm", "arrival_window")).toBe("Arrival time");
    expect(humanLabel("missingQuoteTerm", "verification")).toBe("Written confirmation");
  });

  it("labels every call outcome in plain language", () => {
    for (const outcome of CALL_OUTCOMES) {
      expect(humanLabel("callOutcome", outcome), outcome).not.toBe(outcome);
      expect(humanLabel("callOutcome", outcome), outcome).not.toMatch(/_/);
    }

    expect(humanLabel("callOutcome", "answered_no_solution")).toBe("Answered, no solution");
  });

  it("uses event and action titles, with safe fallback only for unknown values", () => {
    expect(humanLabel("auditEvent", "supplier.request.sent")).toBe("Supplier request sent");
    expect(humanLabel("auditEvent", "unknown.event")).toBe("Activity recorded");
    expect(humanLabel("actionKind", "supplier_call")).toBe("Supplier call");
    expect(humanLabel("actionKind", "unknown_action")).toBe("Recovery action");
  });

  it("maps a recovery-plan-ready event to its activity title", () => {
    expect(humanLabel("auditEvent", "recovery.plan.ready")).toBe("Plan ready for approval");
  });

  it("labels each action outcome event type", () => {
    for (const outcome of ["prepared", "dispatching", "submitted", "confirmed", "failed", "unknown", "cancelled"]) {
      const eventType = `action.${outcome}`;
      expect(humanLabel("auditEvent", eventType), eventType).not.toBe("Activity recorded");
    }

    expect(humanLabel("auditEvent", "action.submitted")).toBe("Supplier call started");
  });

  it("labels the remaining dynamically generated audit event types", () => {
    const eventTypes = [
      "case.control.cancel",
      "case.control.pause.dispatch_effects",
      "case.control.resume.dispatch_effects",
      "case.control.cancel.dispatch_effects",
      "supplier.approval.contact",
      "supplier.approval.supplier",
      "receipt.received",
      "receipt.reversal",
    ];

    for (const eventType of eventTypes) {
      expect(humanLabel("auditEvent", eventType), eventType).not.toBe("Activity recorded");
    }
  });

  it("labels every audit event type observed in the production org", () => {
    const eventTypes = [
      "action.dispatching",
      "action.prepared",
      "action.submitted",
      "case.control.cancel.dispatch_effects",
      "case.control.close",
      "connection.gmail.connected",
      "policy.version_created",
      "voice.callback.recorded",
    ];

    for (const eventType of eventTypes) {
      expect(humanLabel("auditEvent", eventType), eventType).not.toBe("Activity recorded");
    }
  });

  it("maps every case phase to its punched-ticket stage", () => {
    const expected: Record<CasePhase, ReturnType<typeof phaseStage>> = {
      new: { current: 1, total: 5 },
      needs_review: { current: 1, total: 5, stuck: true },
      assessing: { current: 2, total: 5 },
      recovering: { current: 3, total: 5 },
      awaiting_supplier: { current: 3, total: 5 },
      awaiting_approval: { current: 4, total: 5 },
      executing: { current: 5, total: 5 },
      monitoring: { current: 5, total: 5 },
      closed: { current: 5, total: 5 },
    };

    for (const phase of Object.keys(expected) as CasePhase[]) {
      expect(phaseStage(phase), phase).toEqual(expected[phase]);
    }
  });

  it("gives every audit event on the Harbor replay case a specific title", () => {
    const eventTypes = [
      "assessment.recalculated",
      "demo.reset",
      "import.activated",
      "outreach.drafted",
      "plan.approved",
      "policy.version_created",
      "purchase_order.line_matched",
      "recovery.plan.ready",
      "supplier.delay.received",
      "supplier.offer.verified",
      "supplier.request.sent",
    ];

    for (const eventType of eventTypes) {
      expect(humanLabel("auditEvent", eventType), eventType).not.toBe("Activity recorded");
    }
  });
});
