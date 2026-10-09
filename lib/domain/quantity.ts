import { DomainValidationError } from "./errors";

export const MAX_QUANTITY = 1_000_000_000;

export function isQuantity(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_QUANTITY
  );
}

export function assertQuantity(value: number, label: string): asserts value is number {
  if (!isQuantity(value)) {
    throw new DomainValidationError("out_of_range", label, `${label} must be an integer from 0 to ${MAX_QUANTITY}`);
  }
}

export type ParseQuantityResult =
  | { ok: true; value: number }
  | { ok: false; code: "not_integer" | "out_of_range" | "empty" };

export function parseQuantity(value: string): ParseQuantityResult {
  if (value.length === 0) return { ok: false, code: "empty" };
  if (!/^\d+$/.test(value)) return { ok: false, code: "not_integer" };

  const parsed = BigInt(value);
  if (parsed > BigInt(MAX_QUANTITY)) return { ok: false, code: "out_of_range" };
  return { ok: true, value: Number(parsed) };
}
