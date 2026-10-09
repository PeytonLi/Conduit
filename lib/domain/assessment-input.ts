import { parseMinorUnits } from "./money";
import { parseInstant, toIso } from "./time";
import type { AssessmentContext } from "./assessment";
import type { ProjectionInput } from "./types";

export type ProjectionFacts = {
  dataset: { id: string; source_type: "csv" | "connector" | "fixture"; source_as_of: string; content_hash: string } | null;
  item: { id: string; base_unit: string; specification: Record<string, unknown> } | null;
  location: { id: string; timezone: string } | null;
  inventory: { id: string; physical_qty: number; unusable_qty: number; outside_allocations_qty: number; source_as_of: string } | null;
  demand: {
    id: string;
    external_id: string;
    remaining_qty: number;
    required_at: string;
    certainty: "confirmed" | "forecast";
    included_reserved_qty: number;
    source_as_of: string;
  }[];
  receipts: {
    id: string;
    po_line_id: string;
    quantity_remaining: number;
    earliest_at: string | null;
    latest_at: string | null;
    promise_state: "confirmed" | "estimated" | "unknown";
    evidence_id: string | null;
    source_as_of: string;
  }[];
  lines: { id: string; ordered_qty: number; received_qty: number; cancelled_qty: number; unit_price_minor: string }[];
  claims: { id: string; quantity: number }[];
};

type PlanLines = Record<
  string,
  { remainingQty: number; receiptIds: string[]; unitPriceMinor: bigint }
>;

export function buildProjectionInput(
  facts: ProjectionFacts,
  options: { horizonDays?: number; safetyBufferQty?: number } = {},
): {
  input: ProjectionInput | null;
  context: Omit<AssessmentContext, "now" | "mode">;
  lines: PlanLines;
  missingFacts: string[];
} {
  const missingFacts: string[] = [];
  if (!facts.dataset) missingFacts.push("missing:active_dataset");
  if (!facts.item) missingFacts.push("missing:item");
  if (!facts.location) missingFacts.push("missing:location");
  if (!facts.inventory) missingFacts.push("missing:inventory_snapshot");

  const itemBaseUnit = facts.item?.base_unit ?? "";
  const sources: AssessmentContext["sources"] = [];
  if (facts.inventory) {
    sources.push({ kind: "inventory", id: facts.inventory.id, sourceAsOf: facts.inventory.source_as_of });
  }
  for (const demand of facts.demand) {
    sources.push({ kind: "demand", id: demand.id, sourceAsOf: demand.source_as_of });
  }
  for (const receipt of facts.receipts) {
    sources.push({ kind: "commitments", id: receipt.id, sourceAsOf: receipt.source_as_of });
  }

  const lines: PlanLines = Object.fromEntries(
    facts.lines.map((line) => [
      line.id,
      {
        remainingQty: line.ordered_qty - line.received_qty - line.cancelled_qty,
        receiptIds: facts.receipts.filter((receipt) => receipt.po_line_id === line.id).map((receipt) => receipt.id),
        unitPriceMinor: parseMinorUnits(line.unit_price_minor),
      },
    ]),
  );
  const context: Omit<AssessmentContext, "now" | "mode"> = {
    itemBaseUnit,
    sources,
    sourceType: facts.dataset?.source_type,
  };
  if (missingFacts.length > 0) return { input: null, context, lines, missingFacts };

  const horizonDays = options.horizonDays ?? 30;
  const sourceAsOf = facts.inventory!.source_as_of;
  const startMs = parseInstant(sourceAsOf);
  if (
    startMs === null ||
    !Number.isFinite(horizonDays) ||
    horizonDays <= 0 ||
    horizonDays > 30 ||
    !Number.isSafeInteger(horizonDays)
  ) {
    return { input: null, context, lines, missingFacts: ["invalid_horizon"] };
  }
  const horizonEnd = toIso(startMs + horizonDays * 24 * 60 * 60 * 1000);
  const input: ProjectionInput = {
    t0: sourceAsOf,
    timezone: facts.location!.timezone,
    unit: itemBaseUnit,
    horizonEnd,
    physicalQty: facts.inventory!.physical_qty,
    unusableQty: facts.inventory!.unusable_qty,
    outsideAllocationsQty: facts.inventory!.outside_allocations_qty,
    safetyBufferQty: options.safetyBufferQty ?? 0,
    receipts: facts.receipts.map((receipt) => ({
      id: receipt.id,
      quantity: receipt.quantity_remaining,
      earliestAt: receipt.earliest_at,
      latestAt: receipt.latest_at,
      dateOnly: false,
      promiseState: receipt.promise_state,
      evidenceIds: receipt.evidence_id ? [receipt.evidence_id] : [],
    })),
    demand: facts.demand.map((demand) => ({
      id: demand.id,
      quantity: demand.remaining_qty,
      requiredAt: demand.required_at,
      certainty: demand.certainty,
      includedReservedQty: demand.included_reserved_qty,
    })),
    pendingClaims: facts.claims.map((claim) => ({ id: claim.id, quantity: claim.quantity })),
  };
  return { input, context, lines, missingFacts: [] };
}
