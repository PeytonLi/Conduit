import { describe, expect, it } from "vitest";
import { humanLabel } from "@/lib/ui/labels";

describe("UI labels", () => {
  it("provides plain-language call outcome and quote-term labels", () => {
    expect(humanLabel("callOutcome", "answered_with_offer")).toBe("Offer received");
    expect(humanLabel("callOutcome", "no_answer")).toBe("No answer");
    expect(humanLabel("missingQuoteTerm", "nonrecoverable_tax")).toBe("Non-recoverable tax");
    expect(humanLabel("missingQuoteTerm", "arrival_window")).toBe("Arrival time");
    expect(humanLabel("missingQuoteTerm", "verification")).toBe("Written confirmation");
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
});
