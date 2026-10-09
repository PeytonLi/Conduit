import { DomainValidationError } from "./errors";
import { assertQuantity } from "./quantity";

export const MAX_MONEY_MINOR = 1_000_000_000_000n;

function assertCurrency(currency: string): void {
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new DomainValidationError("invalid_currency", "currency");
  }
}

function assertMoney(value: bigint, field = "amount"): void {
  if (value < -MAX_MONEY_MINOR || value > MAX_MONEY_MINOR) {
    throw new DomainValidationError("out_of_range", field);
  }
}

export function currencyMinorDigits(currency: string): number {
  assertCurrency(currency);
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
    }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    throw new DomainValidationError("invalid_currency", "currency");
  }
}

export function parseMinorUnits(
  value: string,
  options: { allowNegative?: boolean } = {},
): bigint {
  const allowNegative = options.allowNegative ?? false;
  if (value.length === 0) throw new DomainValidationError("empty", "amount");
  if (!(allowNegative ? /^-?\d+$/ : /^\d+$/.test(value))) {
    throw new DomainValidationError("not_integer", "amount");
  }

  const parsed = BigInt(value);
  assertMoney(parsed);
  return parsed;
}

export function parseMajorDecimal(
  value: string,
  currency: string,
  options: { allowNegative?: boolean } = {},
): bigint {
  const digits = currencyMinorDigits(currency);
  if (value.length === 0) throw new DomainValidationError("empty", "amount");

  const allowNegative = options.allowNegative ?? false;
  const match = (allowNegative ? /^(-?)(\d+)(?:\.(\d+))?$/ : /^(\d+)(?:\.(\d+))?$/).exec(value);
  if (!match) throw new DomainValidationError("not_decimal", "amount");

  const sign = allowNegative ? match[1] : "";
  const whole = allowNegative ? match[2] : match[1];
  const fraction = allowNegative ? match[3] : match[2];
  if ((fraction?.length ?? 0) > digits) {
    throw new DomainValidationError("extra_precision", "amount");
  }

  const scale = 10n ** BigInt(digits);
  const minor = BigInt(whole) * scale +
    BigInt((fraction ?? "").padEnd(digits, "0") || "0");
  const result = sign === "-" ? -minor : minor;
  assertMoney(result);
  return result;
}

export function formatMinor(value: bigint, currency: string): string {
  const digits = currencyMinorDigits(currency);
  assertMoney(value);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const scale = 10n ** BigInt(digits);
  const whole = absolute / scale;
  const fraction = absolute % scale;
  const formatted = digits === 0
    ? whole.toString()
    : `${whole}.${fraction.toString().padStart(digits, "0")}`;
  return negative ? `-${formatted}` : formatted;
}

export function toMinorString(value: bigint): string {
  assertMoney(value);
  return value.toString();
}

export function sumMinor(...values: bigint[]): bigint {
  const sum = values.reduce((total, value) => total + value, 0n);
  assertMoney(sum);
  return sum;
}

export function mulQtyPrice(quantity: number, unitPriceMinor: bigint): bigint {
  assertQuantity(quantity, "quantity");
  assertMoney(unitPriceMinor, "unitPriceMinor");
  if (unitPriceMinor < 0n) throw new DomainValidationError("out_of_range", "unitPriceMinor");
  const result = BigInt(quantity) * unitPriceMinor;
  assertMoney(result);
  return result;
}
