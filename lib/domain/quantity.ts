import { DomainValidationError } from "./errors";
import { MAX_QUANTITY_SCALE } from "./units";

export const MAX_QUANTITY = 1_000_000_000;

function decimalPlaces(value: number): number {
  const text = String(value);
  const dot = text.indexOf(".");
  if (dot < 0) return 0;
  return text.length - dot - 1;
}

/** Non-negative quantity with at most `scale` decimal places and within MAX_QUANTITY. */
export function isQuantityAtScale(value: unknown, scale: number): value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_QUANTITY) return false;
  const boundedScale = Math.min(MAX_QUANTITY_SCALE, Math.max(0, scale));
  if (boundedScale === 0) return Number.isSafeInteger(value);
  if (decimalPlaces(value) > boundedScale) return false;
  const scaled = Math.round(value * 10 ** boundedScale);
  return Math.abs(value * 10 ** boundedScale - scaled) < 1e-9;
}

/** Any supported stored quantity (up to MAX_QUANTITY_SCALE decimal places). */
export function isQuantity(value: unknown): value is number {
  return isQuantityAtScale(value, MAX_QUANTITY_SCALE);
}

/** Whole-unit quantity (B0 cartons, pack sizes, ERP boundaries that reject fractions). */
export function isIntegerQuantity(value: unknown): value is number {
  return isQuantityAtScale(value, 0);
}

export function assertQuantity(value: number, label: string, scale = MAX_QUANTITY_SCALE): asserts value is number {
  if (!isQuantityAtScale(value, scale)) {
    const scaleText = scale === 0 ? "integer" : `number with at most ${scale} decimal places`;
    throw new DomainValidationError("out_of_range", label, `${label} must be a ${scaleText} from 0 to ${MAX_QUANTITY}`);
  }
}

export function assertIntegerQuantity(value: number, label: string): asserts value is number {
  assertQuantity(value, label, 0);
}

export type ParseQuantityResult =
  | { ok: true; value: number }
  | { ok: false; code: "not_number" | "out_of_range" | "empty" | "extra_precision" | "invalid_scale" };

function parseDecimalQuantity(value: string, scale: number): ParseQuantityResult {
  if (scale === 0) {
    if (!/^\d+$/.test(value)) return { ok: false, code: "not_number" };
  } else if (!/^\d+(?:\.\d+)?$/.test(value)) {
    return { ok: false, code: "not_number" };
  }
  const fraction = value.includes(".") ? value.split(".")[1] ?? "" : "";
  if (fraction.length > scale) return { ok: false, code: "extra_precision" };
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_QUANTITY) return { ok: false, code: "out_of_range" };
  if (!isQuantityAtScale(parsed, scale)) return { ok: false, code: "extra_precision" };
  return { ok: true, value: parsed };
}

export function parseQuantity(value: string, scale = 0): ParseQuantityResult {
  if (value.length === 0) return { ok: false, code: "empty" };
  if (scale < 0 || scale > MAX_QUANTITY_SCALE || !Number.isInteger(scale)) {
    return { ok: false, code: "invalid_scale" };
  }
  if (scale === 0 && !/^\d+$/.test(value)) {
    return { ok: false, code: "not_number" };
  }
  if (scale > 0) return parseDecimalQuantity(value, scale);
  const parsed = BigInt(value);
  if (parsed > BigInt(MAX_QUANTITY)) return { ok: false, code: "out_of_range" };
  return { ok: true, value: Number(parsed) };
}

/** Fixed-point conversion for exact comparisons (transfers binary search, money). */
export function quantityToScaledInt(value: number, scale = MAX_QUANTITY_SCALE): bigint {
  assertQuantity(value, "quantity", scale);
  return BigInt(Math.round(value * 10 ** scale));
}

export function scaledIntToQuantity(scaled: bigint, scale = MAX_QUANTITY_SCALE): number {
  if (scaled < 0n) throw new DomainValidationError("out_of_range", "quantity");
  return Number(scaled) / 10 ** scale;
}

export function compareQuantities(left: number, right: number, scale = MAX_QUANTITY_SCALE): number {
  const l = quantityToScaledInt(left, scale);
  const r = quantityToScaledInt(right, scale);
  return l === r ? 0 : l < r ? -1 : 1;
}

export function quantitiesEqual(left: number, right: number, scale = MAX_QUANTITY_SCALE): boolean {
  return compareQuantities(left, right, scale) === 0;
}

/** Round a quantity to a supported scale without float drift (half away from zero at the last digit). */
export function normalizeQuantity(value: number, scale: number): number {
  if (!Number.isFinite(value)) throw new DomainValidationError("out_of_range", "quantity");
  const factor = 10 ** scale;
  const scaled = Math.round(value * factor) / factor;
  assertQuantity(scaled, "quantity", scale);
  return scaled;
}
