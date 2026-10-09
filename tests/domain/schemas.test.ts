import { describe, expect, it } from "vitest";
import {
  actionStateSchema,
  assessmentResponseSchema,
  blockReasonSchema,
  casePhaseSchema,
  membershipRoleSchema,
  planStepKindSchema,
  runControlSchema,
} from "@/lib/schemas";

describe("shared schema contracts", () => {
  it("round-trips the canonical assessment response envelope", () => {
    const response = {
      api_schema_version: 1,
      request_id: "40000000-0000-4000-8000-000000000001",
      data: {
        case_id: "40000000-0000-4000-8000-000000000002",
        assessment_version: 2,
        quality: "sufficient",
        unit: "carton",
        first_shortage_at: "2026-10-14T16:00:00Z",
        bridge_quantity: 600,
        requirements: [
          { by: "2026-10-14T16:00:00Z", cumulative_quantity: 200 },
          { by: "2026-10-15T16:00:00Z", cumulative_quantity: 600 },
        ],
        source_as_of: "2026-10-12T15:00:00Z",
        input_fingerprint: "sha256-fixture",
        evidence_ids: ["40000000-0000-4000-8000-000000000003"],
        mode: "replay",
      },
    };

    expect(assessmentResponseSchema.parse(response)).toEqual(response);
  });

  it("accepts the canonical enum values", () => {
    expect(casePhaseSchema.parse("awaiting_approval")).toBe("awaiting_approval");
    expect(runControlSchema.parse("blocked")).toBe("blocked");
    expect(blockReasonSchema.parse("outcome_unknown")).toBe("outcome_unknown");
    expect(actionStateSchema.parse("dispatching")).toBe("dispatching");
    expect(planStepKindSchema.parse("amend_delivery_schedule")).toBe(
      "amend_delivery_schedule",
    );
    expect(membershipRoleSchema.parse("owner")).toBe("owner");
  });
});
