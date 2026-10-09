export interface PlannerLimits {
  modelRequestsPerCycle: number;
  modelRequestsPerEpisode: number;
  providerRetries: number;
  distinctSuppliersPerEpisode: number;
  callsPerSupplier: number;
  callsPerEpisode: number;
  emailsPerSupplier: number;
  searchQueriesPerEpisode: number;
  resultsPerQuery: number;
  distinctPagesPerEpisode: number;
  charsPerPage: number;
  maxCallSeconds: number;
}

export const DEFAULT_LIMITS: PlannerLimits = {
  modelRequestsPerCycle: 8,
  modelRequestsPerEpisode: 24,
  providerRetries: 2,
  distinctSuppliersPerEpisode: 3,
  callsPerSupplier: 1,
  callsPerEpisode: 3,
  emailsPerSupplier: 2,
  searchQueriesPerEpisode: 2,
  resultsPerQuery: 5,
  distinctPagesPerEpisode: 10,
  charsPerPage: 20_000,
  maxCallSeconds: 300,
};

export interface RequestCounts {
  cycle: number;
  episode: number;
}

export function modelBudgetExhausted(
  counts: RequestCounts,
  limits: PlannerLimits = DEFAULT_LIMITS,
): boolean {
  return (
    counts.cycle >= limits.modelRequestsPerCycle ||
    counts.episode >= limits.modelRequestsPerEpisode
  );
}

export function withinLimit(count: number, limit: number): boolean {
  return count < limit;
}
