/** Maximum decimal places stored for item quantities (inventory, demand, PO lines). */
export const MAX_QUANTITY_SCALE = 6;

/**
 * Units that count only in whole numbers in Conduit (cartons, pallets, etc.).
 * Packaging B0 fixtures use these; bulk/weight/length units may allow fractions per item.quantity_scale.
 */
export const INTEGER_ONLY_UNITS = new Set(
  [
    "carton",
    "cartons",
    "each",
    "ea",
    "unit",
    "units",
    "roll",
    "rolls",
    "pallet",
    "pallets",
    "case",
    "cases",
    "box",
    "boxes",
    "bag",
    "bags",
    "bundle",
    "bundles",
    "sheet",
    "sheets",
  ].map((u) => u.toLowerCase()),
);

/** Default scale when items.csv omits quantity_scale: whole units for count nouns, else up to 3 decimals. */
export function defaultQuantityScale(baseUnit: string): number {
  const unit = baseUnit.trim().toLowerCase();
  if (!unit || INTEGER_ONLY_UNITS.has(unit)) return 0;
  if (
    unit === "kg" ||
    unit === "kilogram" ||
    unit === "kilograms" ||
    unit === "g" ||
    unit === "gram" ||
    unit === "grams" ||
    unit === "lb" ||
    unit === "lbs" ||
    unit === "pound" ||
    unit === "pounds" ||
    unit === "oz" ||
    unit === "ounce" ||
    unit === "ounces" ||
    unit === "l" ||
    unit === "liter" ||
    unit === "liters" ||
    unit === "litre" ||
    unit === "litres" ||
    unit === "ml" ||
    unit === "gallon" ||
    unit === "gallons"
  ) {
    return 3;
  }
  if (unit === "m" || unit === "meter" || unit === "meters" || unit === "metre" || unit === "metres" || unit === "ft" || unit === "foot" || unit === "feet") {
    return 2;
  }
  return 0;
}

export function resolveItemQuantityScale(baseUnit: string, explicit: number | null | undefined): number {
  if (explicit !== null && explicit !== undefined && Number.isInteger(explicit) && explicit >= 0 && explicit <= MAX_QUANTITY_SCALE) {
    return explicit;
  }
  return defaultQuantityScale(baseUnit);
}
