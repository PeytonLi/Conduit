export type ActionKind =
  | "supplier_email"
  | "supplier_call"
  | "demo_ledger_amendment"
  | "manual_export";

export interface ActionRecord {
  id: string;
  orgId: string;
  caseId: string;
  kind: ActionKind;
  idempotencyKey: string;
  payloadHash: string;
  payload: unknown;
  providerRef: string | null;
  mode: "replay" | "sandbox" | "live";
}

export interface DispatchResult {
  outcome: "submitted" | "confirmed" | "failed" | "unknown";
  providerRef?: string;
  safeSummary: string;
}

export interface ReconcileResult {
  outcome: "confirmed" | "failed" | "unknown";
  providerRef?: string;
  safeSummary: string;
}

export interface ProviderAdapter {
  kind: ActionKind;
  dispatch(action: ActionRecord): Promise<DispatchResult>;
  findResult(action: ActionRecord): Promise<ReconcileResult>;
}
