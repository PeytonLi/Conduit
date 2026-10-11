type ProjectionAssessmentState = {
  quality: string;
  missing_facts: readonly string[];
} | null;

const missingDataLabels: Record<string, string> = {
  "missing:active_dataset": "an active business-data dataset",
  "missing:item": "an item record",
  "missing:location": "a location record",
  "missing:inventory_snapshot": "an inventory snapshot",
  "missing:unit": "a unit",
  "missing:demand": "demand data",
  "missing:purchase_orders": "purchase-order data",
};

export function projectionEmptyMessage(
  assessment: ProjectionAssessmentState,
): string {
  if (!assessment) return "No assessment snapshot is stored for this case.";

  const missingData = assessment.missing_facts
    .map((fact) => missingDataLabels[fact])
    .filter((value): value is string => value !== undefined);
  if (missingData.length > 0) {
    return `Stock projection is unavailable because required data is missing: ${missingData.join(", ")}.`;
  }
  if (assessment.missing_facts.some((fact) => fact.startsWith("stale:"))) {
    return "Stock projection is unavailable because its source data is stale.";
  }
  if (assessment.missing_facts.some((fact) =>
    fact.startsWith("invalid:") ||
    fact.startsWith("invalid_") ||
    fact.startsWith("contradictory:") ||
    fact.startsWith("duplicate_id:") ||
    fact.startsWith("unit_mismatch:") ||
    fact === "horizon_exceeds_30_days",
  )) {
    return "Stock projection is unavailable because assessment inputs are invalid or inconsistent.";
  }
  if (assessment.quality !== "sufficient") {
    return "Stock projection is unavailable because the assessment inputs are incomplete.";
  }
  return "No stock projection snapshot was stored for this assessment.";
}
