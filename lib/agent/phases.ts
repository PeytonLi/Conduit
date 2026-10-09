import type { CasePhase } from "@/lib/schemas/enums";

/** docs/prd/03 §5.1 allowed transitions (closed -> assessing is reopen-only). */
export const PHASE_TRANSITIONS: Record<CasePhase, readonly CasePhase[]> = {
  new: ["needs_review", "assessing", "closed"],
  needs_review: ["assessing", "closed"],
  assessing: ["needs_review", "recovering", "monitoring", "closed"],
  recovering: [
    "awaiting_supplier",
    "awaiting_approval",
    "needs_review",
    "assessing",
    "closed",
  ],
  awaiting_supplier: ["recovering", "assessing", "needs_review", "closed"],
  awaiting_approval: ["executing", "recovering", "assessing", "closed"],
  executing: ["monitoring", "recovering", "needs_review"],
  monitoring: ["assessing", "closed"],
  closed: [],
};

export function transitionAllowed(from: CasePhase, to: CasePhase): boolean {
  if (from === to) return true;
  return PHASE_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: CasePhase, to: CasePhase): void {
  if (!transitionAllowed(from, to)) {
    throw new Error(`Illegal case phase transition: ${from} -> ${to}`);
  }
}

export const ALL_TOOLS = [
  "read_case",
  "find_order_candidates",
  "calculate_shortage",
  "list_approved_suppliers",
  "search_supplier_web",
  "read_supplier_source",
  "evaluate_quote",
  "request_supplier_email",
  "request_supplier_call",
  "record_provisional_offer",
  "propose_recovery_plan",
  "request_owner_review",
  "wait_for_evidence",
] as const;

export type ToolName = (typeof ALL_TOOLS)[number];

const PHASE_TOOLS: Partial<Record<CasePhase, readonly ToolName[]>> = {
  recovering: ALL_TOOLS,
  awaiting_supplier: [
    "read_case",
    "read_supplier_source",
    "evaluate_quote",
    "record_provisional_offer",
    "propose_recovery_plan",
    "request_owner_review",
    "wait_for_evidence",
  ],
  needs_review: [
    "read_case",
    "find_order_candidates",
    "calculate_shortage",
    "request_owner_review",
  ],
  assessing: [
    "read_case",
    "find_order_candidates",
    "calculate_shortage",
    "request_owner_review",
  ],
};

const DEFAULT_PHASE_TOOLS: readonly ToolName[] = [
  "read_case",
  "request_owner_review",
];

export function allowedTools(phase: CasePhase): readonly ToolName[] {
  return PHASE_TOOLS[phase] ?? DEFAULT_PHASE_TOOLS;
}

export function toolAllowed(phase: CasePhase, tool: string): boolean {
  return (allowedTools(phase) as readonly string[]).includes(tool);
}
