/**
 * Parses a decimal amount spoken by a supplier (e.g. "12.50") into integer minor units.
 * Never uses floating point. Returns null for anything that is not a plain non-negative decimal.
 */
export function parseDecimalToMinor(value: string, fractionDigits = 2): bigint | null {
  const trimmed = value.trim();
  const match = /^(\d{1,12})(?:\.(\d+))?$/.exec(trimmed);
  if (!match) return null;
  const whole = match[1];
  const fraction = match[2] ?? "";
  if (fraction.length > fractionDigits) return null;
  const padded = fraction.padEnd(fractionDigits, "0");
  return BigInt(whole) * 10n ** BigInt(fractionDigits) + BigInt(padded === "" ? "0" : padded);
}
