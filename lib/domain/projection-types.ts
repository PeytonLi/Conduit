export type ProjectionDiagnostics = {
  usableStart: number | null;
  coverageStart: number | null;
  finalBalance: number | null;
  excludedReceipts: {
    id: string;
    reason: "eta_unknown" | "not_confirmed" | "overdue" | "beyond_horizon";
  }[];
  excludedDemand: { id: string; reason: "forecast" | "beyond_horizon" }[];
  pastDueDemandIds: string[];
};
