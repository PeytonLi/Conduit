export function parsePolicyMoneyMinor(value: string): string | null {
  const normalized = value.trim();
  if (!normalized) return null;
  const match = /^(\d+)(?:\.(\d{0,2}))?$/.exec(normalized);
  if (!match) throw new Error("Enter an amount with up to two decimal places.");
  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] ?? "").padEnd(2, "0") || "0");
  return (whole * 100n + fraction).toString();
}
