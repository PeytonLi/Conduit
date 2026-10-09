export const labels = {
  phase: {
    new: "New",
    needs_review: "Needs review",
    assessing: "Assessing",
    recovering: "Recovering",
    awaiting_supplier: "Awaiting supplier",
    awaiting_approval: "Awaiting approval",
    executing: "Executing",
    monitoring: "Monitoring",
    closed: "Closed",
  },
  runControl: {
    active: "Active",
    paused: "Paused",
    blocked: "Blocked",
  },
  blockReason: {
    outcome_unknown: "Outcome unknown",
    stale_data: "Stale business data",
  },
  severity: {
    critical: "Critical",
    urgent: "Urgent",
    warning: "Warning",
    info: "Informational",
    needs_information: "Needs information",
  },
  planStatus: {
    ready: "Ready for approval",
    pending: "Ready for approval",
    awaiting_approval: "Ready for approval",
    draft: "Draft",
    approved: "Approved",
    rejected: "Not approved",
    expired: "Expired",
  },
  executionMode: {
    manual: "Manual execution",
    demo_ledger: "Demo ledger",
    live_connector: "Live connector",
  },
  originalOrderTreatment: {
    split: "Split delivery",
    unchanged: "Keep the original purchase order unchanged",
    cancelled: "Cancel the original purchase order",
    replaced: "Replace the original purchase order",
    unknown: "Unknown",
  },
  evidenceSourceType: {
    email: "Email",
    supplier_specification: "Supplier specification",
    purchase_order: "Purchase order",
    inventory_snapshot: "Inventory snapshot",
    invoice: "Invoice",
    document: "Document",
    fixture: "Demo fixture",
  },
  evidencePurpose: {
    "delay-source": "Supplier delay notice",
    "supplier.delay.received": "Supplier delay notice",
    "purchase_order.line_matched": "Purchase order match",
    "assessment.recalculated": "Stock impact",
    "supplier.request.sent": "Supplier request",
    "supplier.offer.verified": "Verified supplier offer",
    "recovery.plan.ready": "Recovery plan",
    quote: "Supplier quote",
    specification: "Supplier specification",
    inventory: "Inventory snapshot",
    receipt: "Receipt schedule",
  },
  auditEvent: {
    "supplier.delay.received": "Delay received",
    "purchase_order.line_matched": "PO matched",
    "assessment.recalculated": "Stock recalculated",
    "supplier.request.sent": "Request sent to Bay Carton",
    "supplier.offer.verified": "Offer verified",
    "recovery.plan.ready": "Plan ready for approval",
    "demo.reset": "Demo reset",
    "case.control.changed": "Case control changed",
    "case.assessment.requested": "Reassessment requested",
    "case.recovery.requested": "Recovery requested",
    "case.control.resume": "Case resumed",
    "case.control.pause": "Case paused",
    "case.control.accept_risk": "Risk accepted",
    "case.control.close": "Case closed",
  },
  actionKind: {
    supplier_email: "Supplier email",
    supplier_call: "Supplier call",
  },
  membershipRole: {
    owner: "Owner",
    operator: "Operator",
    viewer: "Viewer",
  },
  dataLabel: {
    Replay: "Replay",
    Imported: "Imported",
    Live: "Live",
  },
  datasetStatus: {
    active: "Active",
    superseded: "Superseded",
    invalid: "Needs attention",
  },
  provider: {
    quickbooks: "QuickBooks",
    netsuite: "NetSuite",
    csv: "CSV upload",
    fixture: "Demo fixture",
  },
  policySetting: {},
  capability: {},
  caseOutcome: {
    delivered: "Delivered",
    no_impact: "No impact",
    accepted_risk: "Accepted risk",
    cancelled: "Cancelled",
    unresolved: "Unresolved",
  },
  supplierStatus: {
    approved: "Approved",
    candidate: "Candidate",
    blocked: "Blocked",
    pending: "Pending",
  },
  specificationStatus: {
    match: "Match",
    mismatch: "Mismatch",
    unverified: "Unverified",
  },
  quoteStatus: {
    verified: "Verified",
    provisional: "Provisional",
    rejected: "Rejected",
  },
  feasibility: {
    feasible: "Feasible",
    incomplete: "Incomplete",
    rejected: "Rejected",
  },
  timelineStatus: {
    intended: "Intended",
    submitted: "Submitted",
    confirmed: "Confirmed",
    failed: "Failed",
    unknown: "Unknown",
    info: "Recorded",
  },
  projectionKind: {
    start: "Starting inventory",
    receipt: "Purchase order receipt",
    demand: "Demand",
  },
  connectionStatus: {
    connected: "Connected",
    disconnected: "Disconnected",
    error: "Needs attention",
    pending: "Pending",
  },
  demandCertainty: {
    confirmed: "Confirmed",
    forecast: "Forecast",
    tentative: "Tentative",
  },
  demandStatus: {
    open: "Open",
    fulfilled: "Fulfilled",
    cancelled: "Cancelled",
  },
  purchaseOrderStatus: {
    open: "Open",
    closed: "Closed",
    cancelled: "Cancelled",
  },
} as const;

export type LabelCategory = keyof typeof labels;

const safeFallbacks: Partial<Record<LabelCategory, string>> = {
  auditEvent: "Activity recorded",
  actionKind: "Recovery action",
};

export function humanLabel(category: LabelCategory, value: string | null | undefined): string {
  if (!value) return "Unknown";
  const categoryLabels = labels[category] as Record<string, string>;
  const known = categoryLabels[value];
  if (known) return known;
  if (safeFallbacks[category]) return safeFallbacks[category]!;
  const sentence = value.replace(/[._-]+/g, " ").trim();
  return sentence ? `${sentence[0].toUpperCase()}${sentence.slice(1)}` : "Unknown";
}

export function originalOrderTreatmentLabel(value: string, purchaseOrder?: string): string {
  if (value === "split") {
    return purchaseOrder ? `Split delivery (amend ${purchaseOrder})` : "Split delivery";
  }
  return humanLabel("originalOrderTreatment", value);
}

export function actorLabel(
  actorType: string,
  isReplay: boolean,
  user?: { email: string | null; role: string | null },
): string {
  if (actorType === "user") {
    if (user?.email && user.role) {
      return `${user.email} · ${humanLabel("membershipRole", user.role)}`;
    }
    return "User";
  }
  return isReplay ? "Conduit (replay)" : "Conduit";
}
