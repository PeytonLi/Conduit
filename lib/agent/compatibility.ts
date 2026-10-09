import type { ItemRecord } from "./store";

const DIMS_RE = /(\d+)\s*[x×]\s*(\d+)\s*[x×]\s*(\d+)\s*mm/i;

export function specDims(spec: Record<string, unknown>): number[] | null {
  const l = Number(spec.length_mm ?? spec.l_mm);
  const w = Number(spec.width_mm ?? spec.w_mm);
  const h = Number(spec.height_mm ?? spec.h_mm);
  if ([l, w, h].every((n) => Number.isFinite(n) && n > 0)) return [l, w, h];
  const text = `${spec.dimensions ?? ""} ${spec.dims ?? ""}`;
  const m = text.match(DIMS_RE);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return null;
}

/** Deterministic compatibility: exact ordered match on sorted dims. */
export function computeCompatibility(
  item: ItemRecord,
  text: string,
): "compatible" | "incompatible" | "unknown" {
  const wanted = specDims(item.specification ?? {});
  if (!wanted) return "unknown";
  const found = text.match(DIMS_RE);
  if (!found) return "unknown";
  const a = [...wanted].sort((x, y) => x - y).join("x");
  const b = [Number(found[1]), Number(found[2]), Number(found[3])]
    .sort((x, y) => x - y)
    .join("x");
  return a === b ? "compatible" : "incompatible";
}

export const CANDIDATE_MISSING_FACTS = [
  "current_stock",
  "arrival_date",
  "landed_cost",
  "purchasing_approval",
];
