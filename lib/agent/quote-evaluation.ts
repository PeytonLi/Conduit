import type { ItemRecord, QuoteRecord } from "./store";

export interface QuoteEvaluation {
  missing_terms: string[];
  expired: boolean;
  landed_cost_minor: string | null;
  currency: string | null;
  feasible: boolean;
  reasons: string[];
}

function hasValue(value: string | number | null | undefined): boolean {
  return value !== null && value !== undefined && value !== "";
}

/**
 * Pure quote evaluation per docs/prd/03 §4. Null = missing; explicit 0 is
 * known. landed_cost_minor = qty*unit_price + freight + fees + tax (bigint),
 * null if any component is missing.
 */
export function evaluateQuote(
  quote: QuoteRecord,
  item: ItemRecord,
  now: Date,
): QuoteEvaluation {
  const missing: string[] = [];

  if (!hasValue(quote.quantity)) missing.push("quantity");
  if (!hasValue(quote.unit)) missing.push("unit");
  if (quote.unit && item.base_unit && quote.unit !== item.base_unit) {
    missing.push("unit_mismatch");
  }
  if (!hasValue(quote.unit_price_minor)) missing.push("unit_price");
  if (!hasValue(quote.currency)) missing.push("currency");
  if (!hasValue(quote.freight_minor)) missing.push("freight");
  if (!hasValue(quote.fees_minor)) missing.push("fees");
  if (!hasValue(quote.nonrecoverable_tax_minor)) {
    missing.push("nonrecoverable_tax");
  }
  if (!hasValue(quote.destination_location_id)) missing.push("destination");
  if (!hasValue(quote.arrival_start) || !hasValue(quote.arrival_end)) {
    missing.push("arrival_window");
  }
  if (!hasValue(quote.valid_until)) missing.push("valid_until");
  if (!hasValue(quote.latest_order_at)) missing.push("latest_order_at");
  if (!quote.evidence_ids || quote.evidence_ids.length === 0) {
    missing.push("written_confirmation");
  }

  const expired =
    quote.valid_until !== null &&
    quote.valid_until !== undefined &&
    new Date(quote.valid_until) <= now;

  let landed: bigint | null = null;
  if (
    hasValue(quote.quantity) &&
    hasValue(quote.unit_price_minor) &&
    hasValue(quote.freight_minor) &&
    hasValue(quote.fees_minor) &&
    hasValue(quote.nonrecoverable_tax_minor)
  ) {
    landed =
      BigInt(quote.quantity as number) * BigInt(String(quote.unit_price_minor)) +
      BigInt(String(quote.freight_minor)) +
      BigInt(String(quote.fees_minor)) +
      BigInt(String(quote.nonrecoverable_tax_minor));
  }

  const reasons: string[] = [];
  if (missing.length > 0) reasons.push("missing_terms");
  if (expired) reasons.push("expired");
  if (quote.status === "expired" && !expired) reasons.push("status_expired");

  return {
    missing_terms: missing,
    expired,
    landed_cost_minor: landed === null ? null : landed.toString(),
    currency: quote.currency ?? null,
    feasible: missing.length === 0 && !expired,
    reasons,
  };
}
