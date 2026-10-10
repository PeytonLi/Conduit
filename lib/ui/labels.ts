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
    "supplier.delay.received": "Supplier delay received",
    "supplier.message.received": "Supplier message received",
    "supplier.request.sent": "Supplier request sent",
    "supplier.offer.verified": "Supplier offer verified",
    "purchase_order.line_matched": "Purchase order matched",
    "assessment.recalculated": "Stock impact recalculated",
    "recovery.plan.ready": "Plan ready for approval",
    "demo.reset": "Demo reset",
    "case.opened": "Case opened",
    "case.updated_from_message": "Case updated from supplier message",
    "case.match_review_required": "Case match needs review",
    "case.control.changed": "Case control changed",
    "case.assessment.requested": "Reassessment requested",
    "case.recovery.requested": "Recovery requested",
    "case.control.resume": "Case resumed",
    "case.control.pause": "Case paused",
    "case.control.accept_risk": "Risk accepted",
    "case.control.close": "Case closed",
    "case.reassess.requested": "Reassessment requested",
    "membership.role.changed": "Member access changed",
    "connection.gmail.connected": "Gmail connected",
    "policy.version_created": "Policy updated",
    "plan.created": "Recovery plan created",
    "plan.approved": "Recovery plan approved",
    "plan.rejected": "Recovery plan not approved",
    "approval.expired_before_prepare": "Approval expired before preparation",
    "approval.stale_fingerprint": "Approval needs review",
    "action.prepared": "Recovery action prepared",
    "action.cancelled": "Recovery action cancelled",
    "action.dispatching": "Recovery action sent",
    "action.outcome_conflict": "Recovery action outcome needs review",
    "action.outcome.recorded": "Recovery action outcome recorded",
    "outreach.drafted": "Supplier outreach saved as draft",
    "business.snapshot.activated": "Business data activated",
    "import.activated": "Import activated",
    "receipt.recorded": "Receipt recorded",
    "case.delivered": "Case marked delivered",
    phase_transition_denied: "Case phase change blocked",
  },
  actionKind: {
    supplier_email: "Supplier email",
    supplier_call: "Supplier call",
  },
  callDisposition: {
    answered: "Answered",
    declined: "Supplier declined",
    no_answer: "No answer",
    busy: "Busy",
    voicemail: "Voicemail",
    failed: "Call failed",
    not_reached: "Not reached",
  },
  callOutcome: {
    answered_with_offer: "Offer received",
    answered_no_solution: "Answered — no offer",
    no_answer: "No answer",
    busy: "Busy",
    initiation_failed: "Call could not start",
    interrupted: "Call interrupted",
    voicemail: "Voicemail",
    needs_human: "Needs follow-up",
  },
  procurementResult: {
    provisional_offer: "Provisional offer",
    no_offer: "No offer",
    not_reached: "Not reached",
  },
  missingQuoteTerm: {
    nonrecoverable_tax: "Non-recoverable tax",
    arrival_window: "Arrival time",
    verification: "Written confirmation",
    quantity: "Quantity",
    item_price: "Item price",
    freight: "Freight",
    fees: "Fees",
    validity: "Quote validity",
    latest_order: "Latest order time",
    original_order_treatment: "Original order treatment",
  },
  outreachChannel: {
    email: "Email",
    phone: "Phone",
  },
  outreachDenial: {
    contact_not_found: "Supplier contact not found",
    dispatch_paused: "Dispatch is paused",
    case_not_active: "Case is not active",
    contact_not_approved: "Contact is not approved",
    channel_mismatch: "Contact channel does not match",
    channel_not_permitted: "Channel is not permitted",
    supplier_blocked: "Supplier is blocked",
    channel_disabled: "Channel is disabled by policy",
    outside_contact_hours: "Outside permitted contact hours",
    supplier_limit: "Supplier outreach limit reached",
    call_limit_supplier: "Supplier call limit reached",
    call_limit_case: "Case call limit reached",
    email_limit_supplier: "Supplier email limit reached",
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
  capability: {
    deepseek: "AI planning",
    gmail: "Gmail",
    voice: "Supplier calling",
    exa: "Supplier research",
    neatlogs: "Operations logging",
    inngest: "Background processing",
  },
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
  contactChannel: {
    email: "Email",
    phone: "Phone",
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
