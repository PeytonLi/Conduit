export type ActionKind =
  | "supplier_email"
  | "supplier_call"
  | "demo_ledger_amendment"
  | "manual_export"
  | "live_business_amendment"
  | "live_business_transfer";

export interface ActionRecord {
  id: string;
  orgId: string;
  caseId: string;
  kind: ActionKind;
  idempotencyKey: string;
  payloadHash: string;
  payload: unknown;
  contactId?: string | null;
  providerRef: string | null;
  mode: "replay" | "sandbox" | "live";
}

export interface DispatchResult {
  outcome: "submitted" | "confirmed" | "failed" | "unknown";
  providerRef?: string;
  safeSummary: string;
  errorCode?: string;
}

export interface ReconcileResult {
  outcome: "confirmed" | "failed" | "unknown";
  providerRef?: string;
  safeSummary: string;
  errorCode?: string;
}

export interface ProviderAdapter {
  kind: ActionKind;
  dispatch(action: ActionRecord): Promise<DispatchResult>;
  findResult(action: ActionRecord): Promise<ReconcileResult>;
}
