import "server-only";
import "@/lib/integrations/register-providers";
import { getTransferGate, type TransferGate } from "@/lib/actions/live-step";
import type { Rpc } from "@/lib/actions/rpc";
import { createServiceRpc } from "@/lib/actions/rpc.supabase";
import { sourceSpareQuantity } from "@/lib/domain/transfers";
import type { ProjectionFacts } from "@/lib/domain/assessment-input";
import { createServiceClient } from "@/lib/db/service";
import { QueryError, queryClient, type QueryContext } from "./client";

export interface TransferSourceOption {
  source_location_id: string;
  source_location_name: string;
  physical_qty: number;
  /** Largest quantity that can leave without creating a shortage at this location (deterministic). */
  max_safe_qty: number;
}

export interface TransferExecutionView {
  mode: "execute" | "recommend_only";
  provider: string | null;
  code: string | null;
  reason: string | null;
}

export interface TransferOptions {
  case_id: string;
  assessment_id: string | null;
  item: { id: string; sku: string | null; unit: string };
  destination: { id: string; name: string; timezone: string };
  shortage_qty: number | null;
  currency: string;
  execution: TransferExecutionView;
  sources: TransferSourceOption[];
}

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface TransferOptionDeps {
  rpc?: Rpc;
  gate?: TransferGate | null;
}

async function executionView(orgId: string, gate: TransferGate | null): Promise<TransferExecutionView> {
  if (!gate) return { mode: "recommend_only", provider: null, code: "no_connector", reason: "No business system connector is available." };
  try {
    const status = await gate(orgId);
    return status.mode === "execute"
      ? { mode: "execute", provider: status.provider, code: null, reason: null }
      : { mode: "recommend_only", provider: status.provider, code: status.code, reason: status.reason };
  } catch {
    return { mode: "recommend_only", provider: null, code: "unavailable", reason: "The business system connection could not be checked." };
  }
}

/**
 * Other locations that hold this item and how much each can spare. Quantities come from code
 * (the same projection the case assessment uses), never from a model. Execution is reported
 * separately so a recommend-only connector still shows the option.
 */
export async function getTransferOptions(
  context: QueryContext,
  caseId: string,
  deps: TransferOptionDeps = {},
): Promise<TransferOptions> {
  const client = await queryClient(context);
  const service = createServiceClient();
  const rpc = deps.rpc ?? createServiceRpc();

  const { data: caseRow, error } = await client
    .from("cases")
    .select("id,item_id,location_id,current_assessment_id")
    .eq("org_id", context.orgId)
    .eq("id", caseId)
    .maybeSingle();
  if (error) throw new QueryError("query_failed", 503, "The requested data is temporarily unavailable");
  if (!caseRow) throw new QueryError("case_not_found", 404, "Case not found");

  const [{ data: item }, { data: destination }, { data: assessment }, { data: dataset }, { data: organization }] = await Promise.all([
    service.from("items").select("id,sku,base_unit").eq("org_id", context.orgId).eq("id", caseRow.item_id).maybeSingle(),
    service.from("locations").select("id,name,timezone").eq("org_id", context.orgId).eq("id", caseRow.location_id).maybeSingle(),
    caseRow.current_assessment_id
      ? service.from("assessments").select("id,bridge_qty").eq("org_id", context.orgId).eq("id", caseRow.current_assessment_id).maybeSingle()
      : Promise.resolve({ data: null }),
    service.from("datasets").select("id").eq("org_id", context.orgId).eq("status", "active").maybeSingle(),
    service.from("organizations").select("currency").eq("id", context.orgId).maybeSingle(),
  ]);

  const candidates: Row[] = dataset
    ? ((
        await service
          .from("inventory_snapshots")
          .select("location_id,physical_qty")
          .eq("org_id", context.orgId)
          .eq("dataset_id", dataset.id)
          .eq("item_id", caseRow.item_id)
          .neq("location_id", caseRow.location_id)
          .gt("physical_qty", 0)
      ).data ?? [])
    : [];
  const names = new Map<string, string>(
    candidates.length
      ? (
          (
            await service
              .from("locations")
              .select("id,name")
              .eq("org_id", context.orgId)
              .in("id", candidates.map((c) => c.location_id))
          ).data ?? []
        ).map((l: Row) => [l.id, l.name] as [string, string])
      : [],
  );

  const sources: TransferSourceOption[] = [];
  for (const candidate of candidates) {
    const facts = (await rpc("load_projection_facts", {
      p_org_id: context.orgId,
      p_item_id: caseRow.item_id,
      p_location_id: candidate.location_id,
    })) as ProjectionFacts;
    const spare = sourceSpareQuantity(facts);
    if (!spare.ok) continue;
    sources.push({
      source_location_id: candidate.location_id,
      source_location_name: names.get(candidate.location_id) ?? "Unnamed location",
      physical_qty: spare.physicalQty,
      max_safe_qty: spare.maxSafeQuantity,
    });
  }
  sources.sort((a, b) => b.max_safe_qty - a.max_safe_qty || a.source_location_name.localeCompare(b.source_location_name));

  return {
    case_id: caseId,
    assessment_id: assessment?.id ?? null,
    item: { id: caseRow.item_id, sku: item?.sku ?? null, unit: item?.base_unit ?? "each" },
    destination: { id: caseRow.location_id, name: destination?.name ?? "This location", timezone: destination?.timezone ?? "UTC" },
    shortage_qty: typeof assessment?.bridge_qty === "number" ? assessment.bridge_qty : null,
    currency: organization?.currency ?? "USD",
    execution: await executionView(context.orgId, deps.gate === undefined ? getTransferGate() : deps.gate),
    sources,
  };
}
