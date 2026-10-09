export type MembershipRole = "owner" | "operator" | "viewer";
export type CasePhase =
  | "new"
  | "needs_review"
  | "assessing"
  | "recovering"
  | "awaiting_supplier"
  | "awaiting_approval"
  | "executing"
  | "monitoring"
  | "closed";

export type Severity = "critical" | "urgent" | "warning" | "info" | "needs_information";

export interface PriorityInput {
  id: string;
  phase: CasePhase;
  run_control: "active" | "paused" | "blocked";
  block_reason: string | null;
  has_uncertain_action: boolean;
  first_shortage_at: string | null;
  next_check_at: string | null;
  updated_at: string;
}

export interface NextAction {
  label: string;
  due_at: string | null;
  kind: string;
}

export function priorityRank(value: PriorityInput, now: Date): number {
  if (value.phase === "closed") return 6;
  if (value.run_control === "blocked" || value.has_uncertain_action) return 0;
  if (value.first_shortage_at) {
    const shortageAt = new Date(value.first_shortage_at).getTime();
    if (shortageAt >= now.getTime() && shortageAt <= now.getTime() + 72 * 60 * 60 * 1000) {
      return 1;
    }
  }
  if (value.phase === "awaiting_approval") return 2;
  if (
    value.phase === "awaiting_supplier" &&
    value.next_check_at !== null &&
    new Date(value.next_check_at).getTime() < now.getTime()
  ) {
    return 3;
  }
  if (value.phase === "monitoring") return 5;
  return 4;
}

export function comparePriority(
  left: PriorityInput & { priority_rank: number },
  right: PriorityInput & { priority_rank: number },
): number {
  if (left.priority_rank !== right.priority_rank) {
    return left.priority_rank - right.priority_rank;
  }
  const leftShortage = left.first_shortage_at
    ? new Date(left.first_shortage_at).getTime()
    : Number.POSITIVE_INFINITY;
  const rightShortage = right.first_shortage_at
    ? new Date(right.first_shortage_at).getTime()
    : Number.POSITIVE_INFINITY;
  if (leftShortage !== rightShortage) return leftShortage - rightShortage;
  const updated = new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime();
  if (updated !== 0) return updated;
  return left.id.localeCompare(right.id);
}

export function nextAction(
  phase: CasePhase,
  runControl: "active" | "paused" | "blocked",
  blockReason: string | null,
  role: MembershipRole,
  details: { outcome?: string | null; dueAt?: string | null } = {},
): NextAction {
  if (runControl === "blocked" && blockReason === "outcome_unknown") {
    return { label: "Check whether the update was applied", due_at: details.dueAt ?? null, kind: "reconcile" };
  }
  if (runControl === "blocked" && blockReason === "stale_data") {
    return { label: "Refresh business data", due_at: details.dueAt ?? null, kind: "refresh" };
  }
  if (runControl === "paused") {
    return { label: "Paused — resume when ready", due_at: details.dueAt ?? null, kind: "resume" };
  }

  switch (phase) {
    case "new":
    case "assessing":
      return { label: "Checking the impact", due_at: details.dueAt ?? null, kind: "assess" };
    case "needs_review":
      return { label: "Resolve missing information", due_at: details.dueAt ?? null, kind: "review" };
    case "recovering":
      return { label: "Reviewing recovery options", due_at: details.dueAt ?? null, kind: "options" };
    case "awaiting_supplier":
      return { label: "Waiting for supplier reply", due_at: details.dueAt ?? null, kind: "follow_up" };
    case "awaiting_approval":
      return {
        label: role === "owner" ? "Review and approve the recovery plan" : "Waiting for owner",
        due_at: details.dueAt ?? null,
        kind: role === "owner" ? "approval" : "waiting",
      };
    case "executing":
      return { label: "Recording the approved recovery", due_at: details.dueAt ?? null, kind: "execution" };
    case "monitoring":
      return { label: "Monitoring next delivery", due_at: details.dueAt ?? null, kind: "monitor" };
    case "closed":
      return {
        label: `Closed: ${details.outcome ?? "unresolved"}`,
        due_at: null,
        kind: "closed",
      };
  }
}

export function severityLabel(severity: Severity): string {
  const labels: Record<Severity, string> = {
    critical: "Critical",
    urgent: "Urgent",
    warning: "Warning",
    info: "Informational",
    needs_information: "Needs information",
  };
  return labels[severity];
}

export function deriveSeverity(
  quality: "sufficient" | "insufficient" | null,
  firstShortageAt: string | null,
  now: Date,
): Severity {
  if (quality !== "sufficient") return "needs_information";
  if (!firstShortageAt) return "info";
  const delta = new Date(firstShortageAt).getTime() - now.getTime();
  if (delta <= 24 * 60 * 60 * 1000) return "critical";
  if (delta <= 72 * 60 * 60 * 1000) return "urgent";
  return "warning";
}

export function shortageLabel(
  quality: "sufficient" | "insufficient" | null,
  firstShortageAt: string | null,
): string | null {
  return quality === "sufficient" && firstShortageAt === null
    ? "No shortage in the next 30 days."
    : null;
}

export function dataLabel(
  sourceVersions: Record<string, unknown> | null,
  datasetSourceType: string | null,
): "Replay" | "Imported" | "Live" | null {
  if (sourceVersions?.mode === "replay" || datasetSourceType === "fixture") return "Replay";
  if (datasetSourceType === "csv") return "Imported";
  if (datasetSourceType === "connector") return "Live";
  return null;
}

export function isDataStale(
  sourceAsOf: string | null,
  environmentMode: "live" | "sandbox" | "replay",
  now: Date,
): boolean {
  if (!sourceAsOf) return true;
  if (environmentMode !== "live") return false;
  return now.getTime() - new Date(sourceAsOf).getTime() > 15 * 60 * 1000;
}

export type OptionFeasibility = "feasible" | "incomplete" | "rejected";

export interface OptionForOrdering {
  id: string;
  supplier_status?: string;
  specification_status: "match" | "mismatch" | "unverified";
  quote_status: string;
  written_confirmation: boolean;
  quantity: number | null;
  schedule: { quantity: number; arrival_start: string | null }[];
  costs: { net_incremental_minor: string | null };
  missing_fields: string[];
  reasons: string[];
  feasibility?: OptionFeasibility;
}

export function optionFeasibility(option: OptionForOrdering): OptionFeasibility {
  if (
    option.specification_status === "mismatch" ||
    option.quote_status === "rejected" ||
    option.supplier_status === "blocked"
  ) {
    return "rejected";
  }
  if (
    option.specification_status !== "match" ||
    (option.supplier_status !== undefined && option.supplier_status !== "approved") ||
    option.quote_status !== "verified" ||
    !option.written_confirmation ||
    option.quantity === null ||
    option.schedule.some((row) => !row.arrival_start) ||
    option.costs.net_incremental_minor === null ||
    option.missing_fields.length > 0
  ) {
    return "incomplete";
  }
  return "feasible";
}

export function orderOptions<T extends OptionForOrdering>(options: T[]): (T & {
  feasibility: OptionFeasibility;
})[] {
  const feasibilityRank: Record<OptionFeasibility, number> = {
    feasible: 0,
    incomplete: 1,
    rejected: 2,
  };
  return options
    .map((option) => ({ ...option, feasibility: optionFeasibility(option) }))
    .sort((left, right) => {
      const byFeasibility = feasibilityRank[left.feasibility] - feasibilityRank[right.feasibility];
      if (byFeasibility !== 0) return byFeasibility;
      const leftArrival = Math.min(
        ...left.schedule.map((row) =>
          row.arrival_start ? new Date(row.arrival_start).getTime() : Number.POSITIVE_INFINITY,
        ),
      );
      const rightArrival = Math.min(
        ...right.schedule.map((row) =>
          row.arrival_start ? new Date(row.arrival_start).getTime() : Number.POSITIVE_INFINITY,
        ),
      );
      if (leftArrival !== rightArrival) return leftArrival - rightArrival;
      const leftCost =
        left.costs.net_incremental_minor === null
          ? null
          : BigInt(left.costs.net_incremental_minor);
      const rightCost =
        right.costs.net_incremental_minor === null
          ? null
          : BigInt(right.costs.net_incremental_minor);
      if (leftCost !== rightCost) {
        if (leftCost === null) return 1;
        if (rightCost === null) return -1;
        return leftCost < rightCost ? -1 : 1;
      }
      return left.id.localeCompare(right.id);
    });
}
