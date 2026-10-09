import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectionInput } from "@/lib/domain/types";
import { validateImport } from "@/lib/domain/import-validate";

export const fixtureClock = "2026-10-12T15:00:00Z";

export function harborFiles(): Record<string, string> {
  const directory = join(process.cwd(), "tests/fixtures/harbor-pack");
  return Object.fromEntries(
    [
      "suppliers.csv",
      "items.csv",
      "purchase_orders.csv",
      "purchase_order_lines.csv",
      "receipt_schedules.csv",
      "inventory.csv",
      "demand.csv",
    ].map((file) => [file, readFileSync(join(directory, file), "utf8")]),
  );
}

export function importedHarborProjection(): ProjectionInput {
  const result = validateImport({
    files: harborFiles(),
    metadata: {
      schema_version: 1,
      source_as_of: fixtureClock,
      timezone: "America/Los_Angeles",
      currency: "USD",
    },
    orgCurrency: "USD",
    knownLocations: [{ id: "location-1", externalId: "MAIN-WAREHOUSE", timezone: "America/Los_Angeles" }],
    now: fixtureClock,
  });
  if (!result.ok || result.payload === null) {
    throw new Error(`Harbor fixture import invalid: ${JSON.stringify(result.errors)}`);
  }
  const payload = result.payload;
  return {
    t0: payload.metadata.source_as_of,
    timezone: payload.metadata.timezone,
    unit: payload.items[0].base_unit,
    horizonEnd: "2026-11-11T15:00:00Z",
    physicalQty: payload.inventory[0].physical_qty,
    unusableQty: payload.inventory[0].unusable_qty,
    outsideAllocationsQty: payload.inventory[0].outside_allocations_qty,
    safetyBufferQty: 0,
    receipts: payload.receipt_schedules.map((receipt) => ({
      id: receipt.external_id,
      quantity: receipt.quantity_remaining,
      earliestAt: receipt.earliest_at,
      latestAt: receipt.latest_at,
      dateOnly: false,
      promiseState: receipt.promise_state as "confirmed" | "estimated" | "unknown",
      evidenceIds: [],
    })),
    demand: payload.demand.map((demand) => ({
      id: demand.external_id,
      quantity: demand.remaining_qty,
      requiredAt: demand.required_at,
      certainty: demand.certainty as "confirmed" | "forecast",
      includedReservedQty: demand.included_reserved_qty,
    })),
    pendingClaims: [],
  };
}

export function baseProjection(overrides: Partial<ProjectionInput> = {}): ProjectionInput {
  return {
    t0: "2026-10-12T15:00:00Z",
    timezone: "America/Los_Angeles",
    unit: "carton",
    horizonEnd: "2026-11-11T15:00:00Z",
    physicalQty: 600,
    unusableQty: 0,
    outsideAllocationsQty: 0,
    safetyBufferQty: 0,
    receipts: [],
    demand: [],
    pendingClaims: [],
    ...overrides,
  };
}
