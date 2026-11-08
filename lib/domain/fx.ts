import { DomainValidationError } from "./errors";
import { toMinorString } from "./money";

/** Rate is target minor units per source minor unit, expressed as an exact ratio. */
export type FxRate = {
  id: string;
  from_currency: string;
  to_currency: string;
  numerator: string;
  denominator: string;
  source: string;
  as_of: string;
};

export type FxContext = { home_currency: string; fx_rate?: FxRate | null; fx_max_age_seconds?: number };
export type Conversion = {
  original_minor: string;
  original_currency: string;
  converted_minor: string | null;
  currency: string;
  rate: FxRate | null;
  reason: string | null;
  expires_at: string | null;
};

export function convertCost(amount: bigint, currency: string, context: FxContext, now: Date): Conversion {
  const result: Conversion = {
    original_minor: toMinorString(amount), original_currency: currency,
    converted_minor: null, currency: context.home_currency, rate: null, reason: null, expires_at: null,
  };
  if (!/^[A-Z]{3}$/.test(currency) || !/^[A-Z]{3}$/.test(context.home_currency)) {
    return { ...result, reason: "currency" };
  }
  if (currency === context.home_currency) return { ...result, converted_minor: amount.toString() };
  const rate = context.fx_rate;
  if (!rate || rate.from_currency !== currency || rate.to_currency !== context.home_currency) {
    return { ...result, reason: "fx_rate_missing" };
  }
  const asOf = Date.parse(rate.as_of);
  const age = context.fx_max_age_seconds ?? 86400;
  if (!Number.isFinite(asOf) || !Number.isFinite(now.getTime()) || asOf > now.getTime() ||
      !Number.isSafeInteger(age) || age <= 0 || !rate.source.trim() ||
      !/^[1-9]\d{0,17}$/.test(rate.numerator) || !/^[1-9]\d{0,17}$/.test(rate.denominator)) {
    return { ...result, reason: "fx_rate_invalid" };
  }
  const expires = asOf + age * 1000;
  if (now.getTime() >= expires) return { ...result, reason: "fx_rate_stale" };
  const denominator = BigInt(rate.denominator);
  const product = (amount < 0n ? -amount : amount) * BigInt(rate.numerator);
  // Round once per cost, half away from zero, using integer arithmetic only.
  const rounded = (product * 2n + denominator) / (2n * denominator) * (amount < 0n ? -1n : 1n);
  try {
    toMinorString(rounded);
  } catch (error) {
    if (!(error instanceof DomainValidationError)) throw error;
    return { ...result, reason: "fx_amount_out_of_range" };
  }
  return { ...result, converted_minor: rounded.toString(), rate, expires_at: new Date(expires).toISOString() };
}
