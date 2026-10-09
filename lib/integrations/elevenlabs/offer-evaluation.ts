import type { VoiceOfferContext } from "@/lib/db/voice-store";
import { endOfLocalDate, startOfLocalDate } from "@/lib/domain/time";
import { parseDecimalToMinor } from "./money";

export interface OfferTerms {
  quantity: number;
  currency?: string;
  unit_price?: string;
  freight?: string;
  fees?: string;
  arrival_date?: string;
  quote_valid_until?: string;
  order_cutoff?: string;
  split_delivery?: boolean;
}

export type CeilingStatus = "within" | "above" | "not_configured" | "unknown_cost";

export interface OfferEvaluation {
  missing_fields: string[];
  meets_quantity: boolean | null;
  meets_deadline: boolean | null;
  unit_price_minor: bigint | null;
  freight_minor: bigint | null;
  fees_minor: bigint | null;
  added_cost_minor: bigint | null;
  ceiling_status: CeilingStatus;
}

export function toInstant(value: string | undefined, timeZone: string, boundary: "start" | "end" = "end"): Date | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    try {
      return new Date(boundary === "start" ? startOfLocalDate(value, timeZone) : endOfLocalDate(value, timeZone));
    } catch {
      return null;
    }
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const parseMinor = (value: string | undefined) => (value === undefined ? null : parseDecimalToMinor(value));

/**
 * Deterministic offer check. Added cost = freight + fees + max(0, unit price - original PO price) * quantity,
 * all in integer minor units. The ceiling comes only from policy; it is never shown to the voice agent.
 */
export function evaluateOffer(terms: OfferTerms, context: VoiceOfferContext): OfferEvaluation {
  const missing: string[] = [];
  if (!terms.currency) missing.push("currency");
  if (terms.unit_price === undefined) missing.push("unit_price");
  if (terms.freight === undefined) missing.push("freight");
  if (!terms.arrival_date) missing.push("arrival_date");
  if (!terms.quote_valid_until) missing.push("quote_valid_until");
  if (!terms.order_cutoff) missing.push("order_cutoff");
  if (terms.split_delivery === undefined) missing.push("split_delivery");

  const unitPrice = parseMinor(terms.unit_price);
  const freight = parseMinor(terms.freight);
  const fees = parseMinor(terms.fees) ?? (terms.fees === undefined ? 0n : null);

  const arrival = toInstant(terms.arrival_date, context.timezone);
  const shortage = context.first_shortage_at ? new Date(context.first_shortage_at) : null;
  const meetsDeadline = arrival && shortage ? arrival.getTime() <= shortage.getTime() : null;
  const meetsQuantity = context.bridge_qty === null ? null : terms.quantity >= context.bridge_qty;

  let addedCost: bigint | null = null;
  const sameCurrency = terms.currency !== undefined && terms.currency === context.org_currency;
  if (sameCurrency && unitPrice !== null && freight !== null && fees !== null && context.original_unit_price_minor !== null) {
    const original = BigInt(context.original_unit_price_minor);
    const premium = unitPrice > original ? (unitPrice - original) * BigInt(terms.quantity) : 0n;
    addedCost = premium + freight + fees;
  }

  let ceilingStatus: CeilingStatus;
  if (addedCost === null) ceilingStatus = "unknown_cost";
  else if (context.negotiation_ceiling_minor === null || !/^\d+$/.test(context.negotiation_ceiling_minor)) {
    ceilingStatus = "not_configured";
  } else ceilingStatus = addedCost > BigInt(context.negotiation_ceiling_minor) ? "above" : "within";

  return {
    missing_fields: missing,
    meets_quantity: meetsQuantity,
    meets_deadline: meetsDeadline,
    unit_price_minor: unitPrice,
    freight_minor: freight,
    fees_minor: fees,
    added_cost_minor: addedCost,
    ceiling_status: ceilingStatus,
  };
}
