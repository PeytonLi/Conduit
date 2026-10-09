import { DomainValidationError } from "./errors";
import { projectInventory } from "./inventory";
import { mulQtyPrice, sumMinor } from "./money";
import { isQuantity } from "./quantity";
import { compareText, parseInstant, toIso } from "./time";
import type { ProjectionInput } from "./types";

export type QuoteTerms = {
  id: string;
  supplierId: string;
  supplierPurchasingStatus: "candidate" | "approved" | "blocked";
  contactId: string | null;
  itemId: string;
  spec: {
    lengthMm: number | null;
    widthMm: number | null;
    heightMm: number | null;
    materialGrade: string | null;
  };
  unit: string | null;
  availableQty: number | null;
  packSize: number | null;
  minimumQty: number | null;
  unitPriceMinor: bigint | null;
  currency: string | null;
  freightMinor: bigint | null;
  feesMinor: bigint | null;
  nonrecoverableTaxMinor: bigint | null;
  destinationLocationId: string | null;
  arrivalStart: string | null;
  arrivalEnd: string | null;
  validUntil: string | null;
  latestOrderAt: string | null;
  arrivalGuaranteedUntilExpiry: boolean;
  status: "provisional" | "verified" | "expired" | "rejected" | "superseded";
  writtenConfirmationEvidenceId: string | null;
  verifiedAt: string | null;
  availabilityConfirmedAt: string | null;
  reservesQuantityThroughExecution: boolean;
};

export type QuoteContext = {
  now: string;
  itemId: string;
  itemSpec: { lengthMm: number; widthMm: number; heightMm: number; materialGrade: string };
  itemBaseUnit: string;
  orgCurrency: string;
  destinationLocationId: string;
  requiredQty: number;
  projection?: ProjectionInput;
  substitutionRules?: {
    field: "lengthMm" | "widthMm" | "heightMm" | "materialGrade";
    allowedValue: number | string;
    approvedBy: string;
  }[];
};

export type QuoteEvaluation = {
  quoteId: string;
  outcome: "feasible" | "needs_revalidation" | "incomplete" | "rejected";
  reasons: string[];
  missingTerms: string[];
  orderQty: number | null;
  surplusQty: number | null;
  landedCostMinor: bigint | null;
  surplusCostMinor: bigint | null;
  coversAllDeadlines: boolean | null;
  effectiveArrivalAt: string | null;
  writtenConfirmationEvidenceId?: string | null;
};

function compatibleSubstitution(
  q: QuoteTerms,
  context: QuoteContext,
  field: keyof QuoteTerms["spec"],
): boolean {
  return context.substitutionRules?.some(
    (rule) => rule.field === field && rule.allowedValue === q.spec[field] && rule.approvedBy.length > 0,
  ) ?? false;
}

export function evaluateQuote(q: QuoteTerms, context: QuoteContext): QuoteEvaluation {
  const reasons: string[] = [];
  const missingTerms: string[] = [];
  const reject = (reason: string): QuoteEvaluation => ({
    quoteId: q.id,
    outcome: "rejected",
    reasons: [...reasons, reason],
    missingTerms,
    orderQty: null,
    surplusQty: null,
    landedCostMinor: null,
    surplusCostMinor: null,
    coversAllDeadlines: false,
    effectiveArrivalAt: q.arrivalEnd,
  });

  if (q.itemId !== context.itemId) return reject("item_mismatch");
  if (q.unit !== null && q.unit !== context.itemBaseUnit) return reject("unit_mismatch");
  for (const field of ["lengthMm", "widthMm", "heightMm", "materialGrade"] as const) {
    const value = q.spec[field];
    if (value !== null && value !== context.itemSpec[field] && !compatibleSubstitution(q, context, field)) {
      return reject("specification_mismatch");
    }
  }
  if (q.currency !== null && q.currency !== context.orgCurrency) return reject("currency_mismatch");
  if (q.destinationLocationId !== null && q.destinationLocationId !== context.destinationLocationId) {
    return reject("destination_mismatch");
  }
  if (q.supplierPurchasingStatus === "blocked") return reject("supplier_blocked");
  if (q.status === "rejected" || q.status === "superseded") return reject(`quote_${q.status}`);
  if (q.status === "expired") return reject("expired_requires_renewal");
  if (
    [q.unitPriceMinor, q.freightMinor, q.feesMinor, q.nonrecoverableTaxMinor]
      .some((amount) => amount !== null && amount < 0n)
  ) {
    return reject("negative_quote_amount");
  }

  const now = parseInstant(context.now);
  if (now === null) missingTerms.push("now");
  const validUntil = q.validUntil === null ? null : parseInstant(q.validUntil);
  const latestOrderAt = q.latestOrderAt === null ? null : parseInstant(q.latestOrderAt);
  if (now !== null && validUntil !== null && now > validUntil) return reject("expired_requires_renewal");
  if (now !== null && latestOrderAt !== null && now > latestOrderAt) return reject("order_cutoff_passed");

  if (q.contactId === null) missingTerms.push("contactId");
  if (Object.values(q.spec).some((value) => value === null)) missingTerms.push("specification");
  if (q.unit === null) missingTerms.push("unit");
  if (q.availableQty === null) missingTerms.push("availableQty");
  if (q.unitPriceMinor === null) missingTerms.push("unitPriceMinor");
  if (q.currency === null) missingTerms.push("currency");
  if (q.freightMinor === null) missingTerms.push("freightMinor");
  if (q.feesMinor === null) missingTerms.push("feesMinor");
  if (q.nonrecoverableTaxMinor === null) missingTerms.push("nonrecoverableTaxMinor");
  if (q.destinationLocationId === null) missingTerms.push("destinationLocationId");
  if (q.arrivalEnd === null) missingTerms.push("arrivalEnd");
  if (q.validUntil === null) missingTerms.push("validUntil");
  if (q.latestOrderAt === null && !(q.arrivalGuaranteedUntilExpiry && q.validUntil !== null)) {
    missingTerms.push("latestOrderAt");
  }
  if (q.writtenConfirmationEvidenceId === null) missingTerms.push("writtenConfirmationEvidenceId");
  if (q.packSize === null) missingTerms.push("packSize");
  if (q.minimumQty === null) missingTerms.push("minimumQty");
  if (q.status === "provisional") missingTerms.push("not_written_verified");
  if (q.supplierPurchasingStatus === "candidate") missingTerms.push("supplier_not_approved");
  if (q.status === "verified" && q.verifiedAt === null) missingTerms.push("verifiedAt");

  let orderQty: number | null = null;
  let surplusQty: number | null = null;
  let landedCostMinor: bigint | null = null;
  let surplusCostMinor: bigint | null = null;
  let invalidCost = false;
  const packSize = q.packSize;
  const minimumQty = q.minimumQty;
  if (
    isQuantity(context.requiredQty) &&
    packSize !== null && isQuantity(packSize) && packSize > 0 &&
    minimumQty !== null && isQuantity(minimumQty)
  ) {
    const needed = Math.max(context.requiredQty, minimumQty);
    orderQty = Math.ceil(needed / packSize) * packSize;
    if (!isQuantity(orderQty)) {
      reasons.push("order_quantity_out_of_range");
      orderQty = null;
    } else {
      surplusQty = orderQty - context.requiredQty;
      if (q.availableQty !== null && isQuantity(q.availableQty) && q.availableQty < orderQty) {
        return {
          ...reject("insufficient_availability"),
          orderQty,
          surplusQty,
        };
      }
      if (
        q.unitPriceMinor !== null &&
        q.freightMinor !== null &&
        q.feesMinor !== null &&
        q.nonrecoverableTaxMinor !== null
      ) {
        try {
          const itemCost = mulQtyPrice(orderQty, q.unitPriceMinor);
          landedCostMinor = sumMinor(itemCost, q.freightMinor, q.feesMinor, q.nonrecoverableTaxMinor);
          surplusCostMinor = mulQtyPrice(surplusQty, q.unitPriceMinor);
        } catch (error) {
          if (error instanceof DomainValidationError) {
            reasons.push(error.code);
            invalidCost = true;
          } else {
            throw error;
          }
        }
      }
    }
  }

  if (q.availableQty !== null && !isQuantity(q.availableQty)) missingTerms.push("availableQty");
  if (packSize !== null && (!isQuantity(packSize) || packSize === 0)) missingTerms.push("packSize");
  if (minimumQty !== null && !isQuantity(minimumQty)) missingTerms.push("minimumQty");

  let coversAllDeadlines: boolean | null = null;
  const effectiveLatestOrder = q.latestOrderAt ?? (q.arrivalGuaranteedUntilExpiry ? q.validUntil : null);
  if (q.arrivalEnd !== null && parseInstant(q.arrivalEnd) === null) missingTerms.push("arrivalEnd");
  if (effectiveLatestOrder !== null && parseInstant(effectiveLatestOrder) === null) {
    missingTerms.push("latestOrderAt");
  }
  let outcome: QuoteEvaluation["outcome"] = missingTerms.length > 0 ? "incomplete" : "feasible";
  if (invalidCost) outcome = "rejected";
  if (context.projection && orderQty !== null && q.arrivalEnd !== null && parseInstant(q.arrivalEnd) !== null) {
    const evaluated = projectInventory({
      ...context.projection,
      receipts: [
        ...context.projection.receipts,
        {
          id: `quote:${q.id}`,
          quantity: orderQty,
          earliestAt: q.arrivalStart,
          latestAt: q.arrivalEnd,
          dateOnly: false,
          promiseState: "confirmed",
          evidenceIds: q.writtenConfirmationEvidenceId ? [q.writtenConfirmationEvidenceId] : [],
        },
      ],
    });
    coversAllDeadlines = evaluated.quality === "sufficient" && evaluated.bridgeQuantity === 0;
    if (!coversAllDeadlines) {
      reasons.push("misses_deadline");
      outcome = "rejected";
    }
  }
  if (
    (q.status === "provisional" || q.supplierPurchasingStatus === "candidate") &&
    outcome === "feasible"
  ) {
    outcome = "incomplete";
  }
  if (outcome === "feasible" && !q.reservesQuantityThroughExecution) {
    const confirmedAt = parseInstant(q.availabilityConfirmedAt ?? q.verifiedAt ?? "");
    if (confirmedAt === null) {
      missingTerms.push("availabilityConfirmedAt");
      outcome = "incomplete";
    } else if (now !== null && now - confirmedAt > 60 * 60_000) {
      reasons.push("availability_reconfirmation_required");
      outcome = "needs_revalidation";
    }
  }

  return {
    quoteId: q.id,
    outcome,
    reasons,
    missingTerms: [...new Set(missingTerms)],
    orderQty,
    surplusQty,
    landedCostMinor,
    surplusCostMinor,
    coversAllDeadlines,
    effectiveArrivalAt: q.arrivalEnd === null || parseInstant(q.arrivalEnd) === null
      ? null
      : toIso(parseInstant(q.arrivalEnd)!),
    writtenConfirmationEvidenceId: q.writtenConfirmationEvidenceId,
  };
}

export function rankQuotes(evaluations: QuoteEvaluation[]): {
  ranked: QuoteEvaluation[];
  rejected: QuoteEvaluation[];
  recommended: QuoteEvaluation | null;
} {
  const outcomeRank = { feasible: 0, needs_revalidation: 1, incomplete: 2 } as const;
  const eligible = evaluations.filter(
    (evaluation): evaluation is QuoteEvaluation & { outcome: keyof typeof outcomeRank } =>
      evaluation.outcome !== "rejected",
  );
  const compareNullableMoney = (left: bigint | null, right: bigint | null): number => {
    if (left === null) return right === null ? 0 : 1;
    if (right === null) return -1;
    return left < right ? -1 : left > right ? 1 : 0;
  };
  const compareArrival = (left: string | null, right: string | null): number => {
    const leftMs = left === null ? null : parseInstant(left);
    const rightMs = right === null ? null : parseInstant(right);
    if (leftMs === null) return rightMs === null ? 0 : 1;
    if (rightMs === null) return -1;
    return leftMs < rightMs ? -1 : leftMs > rightMs ? 1 : 0;
  };
  const ranked = eligible.sort(
    (left, right) =>
      outcomeRank[left.outcome] - outcomeRank[right.outcome] ||
      compareArrival(left.effectiveArrivalAt, right.effectiveArrivalAt) ||
      compareNullableMoney(left.landedCostMinor, right.landedCostMinor) ||
      Number(Boolean(right.writtenConfirmationEvidenceId)) -
        Number(Boolean(left.writtenConfirmationEvidenceId)) ||
      compareText(left.quoteId, right.quoteId),
  );
  const recommended = ranked[0]?.outcome === "feasible" ? ranked[0] : null;
  return {
    ranked,
    rejected: evaluations.filter((evaluation) => evaluation.outcome === "rejected"),
    recommended,
  };
}

export function incrementalCost(args: {
  newRecoveryCostMinor: bigint;
  originalOrderChangeFeesMinor: bigint;
  confirmedOriginalOrderCreditsMinor: bigint;
}): bigint {
  return sumMinor(
    args.newRecoveryCostMinor,
    args.originalOrderChangeFeesMinor,
    -args.confirmedOriginalOrderCreditsMinor,
  );
}
