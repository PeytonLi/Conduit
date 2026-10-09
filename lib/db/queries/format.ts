export function formatDateTime(iso: string | Date | null, timeZone: string): string | null {
  if (iso === null) return null;
  const date = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone,
  }).format(date);
}

export function formatMoney(
  minorUnits: string | bigint | null,
  currency: string,
): string | null {
  if (minorUnits === null) return null;
  const value = typeof minorUnits === "bigint" ? minorUnits : BigInt(minorUnits);
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(3, "0");
  const dollars = digits.slice(0, -2) || "0";
  const cents = digits.slice(-2);
  return `${currency} ${negative ? "-" : ""}${dollars}.${cents}`;
}

export function formatQuantity(quantity: number | string | null, unit: string): string | null {
  if (quantity === null) return null;
  const value = typeof quantity === "number" ? quantity : Number(quantity);
  if (!Number.isFinite(value)) return null;
  const formatted = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(value);
  const normalizedUnit = value === 1 && unit.endsWith("s") ? unit.slice(0, -1) : unit;
  return `${formatted} ${normalizedUnit}`;
}
