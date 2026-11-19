import { assessInventory } from "@/lib/domain/assessment";
import type { ProjectionFactsResult } from "@/lib/agent/store";
import { inngest } from "./client";

type Pair = { item_id: string; location_id: string };

export interface ShortageScanDeps {
  listPairs(orgId: string, datasetId: string): Promise<Pair[]>;
  loadInput(orgId: string, pair: Pair): Promise<ProjectionFactsResult>;
  getMode(orgId: string): Promise<"replay" | "sandbox" | "live">;
  openCase(orgId: string, pair: Pair, reason: string): Promise<{ status: string; case_id: string }>;
  now(): Date;
}

/**
 * After new business data activates, projects every item/location with open demand and
 * opens a case wherever stock plus incoming receipts fall short. Assessment and recovery
 * then run exactly as they do for a supplier delay email. Insufficient data never opens a case.
 */
export async function scanForShortages(
  deps: ShortageScanDeps,
  input: { orgId: string; datasetId: string },
): Promise<{ scanned: number; opened: string[] }> {
  const mode = await deps.getMode(input.orgId);
  if (mode === "replay") return { scanned: 0, opened: [] };
  const pairs = await deps.listPairs(input.orgId, input.datasetId);
  const opened: string[] = [];
  for (const pair of pairs) {
    const built = await deps.loadInput(input.orgId, pair);
    if (!built.input || built.missingFacts.length > 0) continue;
    const { projection } = assessInventory(built.input, {
      ...built.context,
      now: deps.now().toISOString(),
      mode,
    });
    if (projection.quality !== "sufficient" || !projection.firstShortageAt) continue;
    const result = await deps.openCase(
      input.orgId,
      pair,
      `Business data projects a shortage starting ${projection.firstShortageAt}`,
    );
    if (result.status === "opened") opened.push(result.case_id);
  }
  return { scanned: pairs.length, opened };
}

async function serviceDeps(): Promise<ShortageScanDeps> {
  const [{ createServiceRpc }, imports, { SupabasePlannerStore }] = await Promise.all([
    import("@/lib/actions/rpc.supabase"),
    import("@/lib/db/imports"),
    import("@/lib/agent/store-supabase"),
  ]);
  const rpc = createServiceRpc();
  const importStore = imports.createSupabaseImportStore();
  const planner = new SupabasePlannerStore();
  return {
    listPairs: async (orgId, datasetId) =>
      (await rpc("business_demand_pairs", { p: { org_id: orgId, dataset_id: datasetId } })) as Pair[],
    loadInput: (orgId, pair) =>
      imports.loadProjectionInput(importStore, { orgId, itemId: pair.item_id, locationId: pair.location_id }),
    getMode: async (orgId) => (await planner.getOrgMode(orgId)) ?? "replay",
    openCase: async (orgId, pair, reason) =>
      (await rpc("business_open_shortage_case", {
        p: { org_id: orgId, item_id: pair.item_id, location_id: pair.location_id, reason },
      })) as { status: string; case_id: string },
    now: () => new Date(),
  };
}

export const businessShortageScan = inngest.createFunction(
  {
    id: "business-shortage-scan",
    triggers: [{ event: "business.snapshot.activated" }],
    concurrency: [{ key: "event.data.org_id", limit: 1 }],
  },
  async ({ event, step }) => {
    const data = event.data as { org_id: string; dataset_id: string };
    const report = await step.run("scan", async () =>
      scanForShortages(await serviceDeps(), { orgId: data.org_id, datasetId: data.dataset_id }),
    );
    if (report.opened.length) {
      const { publishPending, serverLedger } = await import("@/lib/actions/server");
      await step.run("publish", () => publishPending(serverLedger()));
    }
    return report;
  },
);
