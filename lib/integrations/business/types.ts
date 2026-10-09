export type BusinessConnectorMode = "csv_snapshot" | "demo_ledger" | "live_connector";

export interface ConnectorCapabilities {
  can_read: boolean;
  can_revalidate: boolean;
  can_write: boolean;
  can_reconcile: boolean;
  can_receive: boolean;
}

export interface BusinessSnapshotRequest {
  orgId: string;
  datasetId?: string;
  sourceAsOf?: string;
}

export interface MaterialFactsRequest {
  orgId: string;
  caseId: string;
  expectedVersion: number;
}

export interface BusinessChangeRequest {
  orgId: string;
  caseId: string;
  actionId: string;
  expectedVersion: number;
  payload: unknown;
}

export interface BusinessConnector {
  capabilities: ConnectorCapabilities;
  mode: BusinessConnectorMode;
  readSnapshot(input: BusinessSnapshotRequest): Promise<unknown>;
  refreshMaterialFacts(input: MaterialFactsRequest): Promise<unknown>;
  prepareChange(input: BusinessChangeRequest): Promise<unknown>;
  applyApprovedChange(input: BusinessChangeRequest): Promise<unknown>;
  findChangeResult(input: BusinessChangeRequest): Promise<unknown>;
  readReceipts(input: BusinessSnapshotRequest): Promise<unknown>;
}
