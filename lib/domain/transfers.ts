import { buildProjectionInput, type ProjectionFacts } from "./assessment-input";
import { projectInventory } from "./inventory";
import { isQuantity, quantityToScaledInt, scaledIntToQuantity } from "./quantity";
import { MAX_QUANTITY_SCALE } from "./units";
import type { ProjectionInput } from "./types";

/**
 * What a business connector can do for an internal stock transfer. A transfer is executable
 * only when all three hold (docs/prd/01 J06): the source stock is reserved so nothing else
 * consumes it, the shipment is dispatched, and arrival can be read back from the system.
 */
export interface TransferCapabilities {
  reserve: boolean;
  dispatch: boolean;
  receive: boolean;
}

export const NO_TRANSFER_CAPABILITIES: TransferCapabilities = { reserve: false, dispatch: false, receive: false };

/** Execution blockers (stable codes) for a connector's declared transfer capabilities. */
export function transferCapabilityBlockers(capabilities: TransferCapabilities | undefined): string[] {
  const caps = capabilities ?? NO_TRANSFER_CAPABILITIES;
  const blockers: string[] = [];
  if (!caps.reserve) blockers.push("transfer_unsupported_reserve");
  if (!caps.dispatch) blockers.push("transfer_unsupported_dispatch");
  if (!caps.receive) blockers.push("transfer_unsupported_receive");
  return blockers;
}

export type TransferCoverage =
  | { ok: true; maxSafeQuantity: number; sourceFloorQuantity: number }
  | {
      ok: false;
      code: "source_coverage_insufficient" | "invalid_quantity" | "source_facts_incomplete";
      maxSafeQuantity: number;
    };

function withTransferDemand(source: ProjectionInput, quantity: number, stepId: string): ProjectionInput {
  return {
    ...source,
    demand: [
      ...source.demand,
      {
        id: `${stepId}:transfer-demand`,
        quantity,
        requiredAt: source.t0,
        certainty: "confirmed",
        includedReservedQty: 0,
      },
    ],
  };
}

/**
 * The deterministic "does not create a shortage at the source" rule. The moved quantity is
 * treated as demand at the source that is due immediately, so every dated source requirement
 * must still be covered by what stays behind plus the source's own confirmed receipts.
 */
export function transferLeavesSourceCovered(source: ProjectionInput, quantity: number, stepId: string): boolean {
  const projection = projectInventory(withTransferDemand(source, quantity, stepId));
  return projection.quality === "sufficient" && (projection.bridgeQuantity ?? 0) === 0;
}

/**
 * Largest quantity that can leave the source without causing any source shortage. Coverage is
 * monotonic in the quantity, so a binary search over the source's physical stock is exact.
 */
export function maxSafeTransferQuantity(source: ProjectionInput, scale = MAX_QUANTITY_SCALE): number {
  if (!transferLeavesSourceCovered(source, 0, "probe")) return 0;
  let low = 0n;
  let high = quantityToScaledInt(Math.max(0, source.physicalQty), scale);
  while (low < high) {
    const mid = (low + high + 1n) / 2n;
    const candidate = scaledIntToQuantity(mid, scale);
    if (transferLeavesSourceCovered(source, candidate, "probe")) low = mid;
    else high = mid - 1n;
  }
  return scaledIntToQuantity(low, scale);
}

export type SourceSpare =
  | { ok: true; physicalQty: number; maxSafeQuantity: number }
  | { ok: false; reason: "source_facts_incomplete" };

/** How much a candidate source location can spare, from the same facts the case assessment uses. */
export function sourceSpareQuantity(facts: ProjectionFacts): SourceSpare {
  const { input } = buildProjectionInput(facts);
  if (!input || projectInventory(input).quality !== "sufficient") return { ok: false, reason: "source_facts_incomplete" };
  return { ok: true, physicalQty: input.physicalQty, maxSafeQuantity: maxSafeTransferQuantity(input) };
}

export function checkTransferCoverage(source: ProjectionInput, quantity: number | null, stepId: string): TransferCoverage {
  const baseline = projectInventory(source);
  if (baseline.quality !== "sufficient") return { ok: false, code: "source_facts_incomplete", maxSafeQuantity: 0 };
  const maxSafeQuantity = maxSafeTransferQuantity(source);
  if (quantity === null || !isQuantity(quantity) || quantity <= 0) {
    return { ok: false, code: "invalid_quantity", maxSafeQuantity };
  }
  if (!transferLeavesSourceCovered(source, quantity, stepId)) {
    return { ok: false, code: "source_coverage_insufficient", maxSafeQuantity };
  }
  return { ok: true, maxSafeQuantity, sourceFloorQuantity: Math.max(0, source.physicalQty - maxSafeQuantity) };
}
