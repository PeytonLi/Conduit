import { describe, expect, it } from "vitest";
import {
  nextAction,
  optionFeasibility,
  orderOptions,
  priorityRank,
  shortageLabel,
  type OptionForOrdering,
  type PriorityInput,
} from "./derive";

const now = new Date("2026-10-12T15:00:00.000Z");

function priority(
  overrides: Partial<PriorityInput> & Pick<PriorityInput, "id">,
): PriorityInput {
  return {
    phase: "recovering",
    run_control: "active",
    block_reason: null,
    has_uncertain_action: false,
    first_shortage_at: null,
    next_check_at: null,
    updated_at: "2026-10-12T15:00:00.000Z",
    ...overrides,
  };
}

function option(
  id: string,
  overrides: Partial<OptionForOrdering> = {},
): OptionForOrdering {
  return {
    id,
    supplier_status: "approved",
    specification_status: "match",
    quote_status: "verified",
    written_confirmation: true,
    quantity: 600,
    schedule: [{ quantity: 600, arrival_start: "2026-10-14T15:00:00.000Z" }],
    costs: { net_incremental_minor: "7500" },
    missing_fields: [],
    reasons: [],
    ...overrides,
  };
}

describe("F6 case derivation", () => {
  it("ranks blocked, imminent, approval, overdue supplier, active, monitoring, and closed", () => {
    const ordered = [
      priority({ id: "blocked", run_control: "blocked" }),
      priority({ id: "imminent", first_shortage_at: "2026-10-14T14:00:00.000Z" }),
      priority({ id: "approval", phase: "awaiting_approval" }),
      priority({
        id: "overdue",
        phase: "awaiting_supplier",
        next_check_at: "2026-10-12T14:59:59.000Z",
      }),
      priority({ id: "active" }),
      priority({ id: "monitoring", phase: "monitoring" }),
      priority({ id: "closed", phase: "closed" }),
    ];
    expect(ordered.map((row) => priorityRank(row, now))).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(priorityRank(priority({ id: "uncertain", has_uncertain_action: true }), now)).toBe(0);
  });

  it("shows the owner decision and the operator waiting state", () => {
    expect(nextAction("awaiting_approval", "active", null, "owner").label)
      .toBe("Review and approve the recovery plan");
    expect(nextAction("awaiting_approval", "active", null, "operator").label)
      .toBe("Waiting for owner");
  });

  it("never treats an unverified quote as feasible", () => {
    expect(optionFeasibility(option("unverified", { specification_status: "unverified" })))
      .toBe("incomplete");
    expect(optionFeasibility(option("provisional", { quote_status: "provisional" })))
      .toBe("incomplete");
    expect(optionFeasibility(option("unapproved", { supplier_status: "candidate" })))
      .toBe("incomplete");
  });

  it("orders feasible Bay Carton before North Packaging, then incomplete and rejected", () => {
    const options = orderOptions([
      option("North Packaging", { costs: { net_incremental_minor: "31200" } }),
      option("Budget Box", {
        specification_status: "mismatch",
        quote_status: "rejected",
        reasons: ["Dimensions do not match"],
      }),
      option("Incomplete", { written_confirmation: false }),
      option("Bay Carton", { costs: { net_incremental_minor: "7500" } }),
    ]);
    expect(options.map((entry) => [entry.id, entry.feasibility])).toEqual([
      ["Bay Carton", "feasible"],
      ["North Packaging", "feasible"],
      ["Incomplete", "incomplete"],
      ["Budget Box", "rejected"],
    ]);
  });

  it("shows the canonical no-shortage message only for sufficient assessments", () => {
    expect(shortageLabel("sufficient", null)).toBe("No shortage in the next 30 days.");
    expect(shortageLabel("insufficient", null)).toBeNull();
    expect(shortageLabel("sufficient", "2026-10-14T16:00:00.000Z")).toBeNull();
  });
});
