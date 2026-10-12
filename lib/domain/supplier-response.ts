import type { ExtractionV1 } from "@/lib/agent/extraction-schema";
import type { VerifiedOfferDates, VerifyResult } from "@/lib/agent/extraction-verify";

export interface SupplierResponseQuote {
  quantity: number | null;
  unit: string | null;
  unit_price_minor: number | null;
  currency: string | null;
  freight_minor: number | null;
  fees_minor: number | null;
  arrival_start: string | null; // ISO UTC
  arrival_end: string | null; // ISO UTC
  valid_until: string | null; // ISO UTC
  latest_order_at: string | null; // ISO UTC
}

/**
 * Turn verified extraction output into provisional-quote inputs for
 * inbox_record_supplier_response. Each verified line that carries offer
 * substance (a quantity or a promised arrival) becomes one quote, so a
 * split-delivery reply produces one quote per leg. Commercial terms from the
 * email-level "offer" block apply to every quote. When the reply states terms
 * but no usable line, a single terms-only quote records them; with no terms at
 * all the response is still recorded, just without a quote.
 */
export function buildResponseQuotes(
  facts: ExtractionV1,
  verify: VerifyResult,
  offerDates: VerifiedOfferDates,
): SupplierResponseQuote[] {
  const offer = facts.offer;
  const offerTerms = {
    unit_price_minor: offer?.unit_price_minor ?? null,
    currency: offer?.currency ?? null,
    freight_minor: offer?.freight_minor ?? null,
    fees_minor: offer?.fees_minor ?? null,
    valid_until: offerDates.valid_until,
    latest_order_at: offerDates.latest_order_at,
  };

  const quotes: SupplierResponseQuote[] = [];
  for (const line of verify.lines) {
    const quantity =
      line.affected_quantity != null && line.affected_quantity > 0
        ? line.affected_quantity
        : null;
    const arrivalStart = line.new_promise?.earliest_at ?? null;
    const arrivalEnd = line.new_promise?.latest_at ?? null;
    if (quantity == null && arrivalEnd == null) continue;
    quotes.push({
      quantity,
      unit: line.unit,
      arrival_start: arrivalStart,
      arrival_end: arrivalEnd,
      ...offerTerms,
    });
  }
  if (quotes.length > 0) return quotes;

  const hasTerms =
    offer != null &&
    (offer.unit_price_minor != null ||
      offer.freight_minor != null ||
      offer.fees_minor != null ||
      offerDates.valid_until != null ||
      offerDates.latest_order_at != null);
  if (!hasTerms) return [];

  return [
    {
      quantity: null,
      unit: null,
      arrival_start: null,
      arrival_end: null,
      ...offerTerms,
    },
  ];
}
