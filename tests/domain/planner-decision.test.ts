import { describe, expect, it } from "vitest";
import { parseModelTurn } from "@/lib/agent/decision";
import type { ModelTurn } from "@/lib/agent/model";

function modelTurn(content: string): ModelTurn {
  return {
    providerRequestId: "request-1",
    model: "deepseek-test",
    message: { content },
    usage: {
      provider: "deepseek",
      request_id: "request-1",
      model: "deepseek-test",
      raw_units: {},
      estimated_cost: null,
      actual_cost: null,
      billing_currency: null,
      rate_version: null,
    },
  };
}

function reviewDecision(payload: Record<string, unknown>) {
  return {
    schema_version: 1,
    decision_type: "request_review",
    concise_reason: "Owner review is required.",
    supporting_evidence_ids: [],
    missing_facts: [],
    payload,
  };
}

describe("request_review decision parsing", () => {
  it("truncates overlong reasons and review arrays before validation", () => {
    const missingFields = Array.from({ length: 21 }, (_, index) => `field-${index}`);
    const objectIds = Array.from(
      { length: 21 },
      (_, index) =>
        `80000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    );
    const result = parseModelTurn(
      modelTurn(
        JSON.stringify(
          reviewDecision({
            reason: "x".repeat(661),
            missing_fields: missingFields,
            object_ids: objectIds,
          }),
        ),
      ),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decision.payload.reason).toBe(`${"x".repeat(499)}…`);
      expect(result.decision.payload.missing_fields).toEqual(
        missingFields.slice(0, 20),
      );
      expect(result.decision.payload.object_ids).toEqual(objectIds.slice(0, 20));
    }
  });

  it("still rejects a non-UUID object_id", () => {
    const result = parseModelTurn(
      modelTurn(
        JSON.stringify(
          reviewDecision({
            reason: "Review needed.",
            missing_fields: [],
            object_ids: ["not-a-uuid"],
          }),
        ),
      ),
    );

    expect(result.ok).toBe(false);
  });

  it("still rejects unknown review payload keys", () => {
    const result = parseModelTurn(
      modelTurn(
        JSON.stringify(
          reviewDecision({
            reason: "Review needed.",
            missing_fields: [],
            object_ids: [],
            unexpected: true,
          }),
        ),
      ),
    );

    expect(result.ok).toBe(false);
  });
});
