import type { AgentToolContext } from "./tools/types";
import type { Clock } from "./clock";
import type { PlannerStore } from "./store";
import { allowedTools } from "./phases";
import { DEFAULT_LIMITS, type PlannerLimits } from "./budgets";

const CAP = 16_000;
const EXCERPT_CAP = 300;

/**
 * Compact JSON case context per docs/prd/05 §1. Never includes transcripts or
 * full message bodies; supplier text is wrapped as untrusted data. Hard cap
 * 16,000 chars — oldest excerpts are dropped first.
 */
export async function buildPlannerContext(
  store: PlannerStore,
  ctx: AgentToolContext & { episode: number },
  clock: Clock,
  limits: PlannerLimits = DEFAULT_LIMITS,
): Promise<Record<string, unknown>> {
  const { orgId, caseId } = ctx;
  const caseRow = await store.getCase(orgId, caseId);
  if (!caseRow) throw new Error("case not found");
  const [item, location, assessment, poLines, quotes, offers, actions, suppliers, policy, evidence] =
    await Promise.all([
      store.getItem(orgId, caseRow.item_id),
      store.getLocation(orgId, caseRow.location_id),
      store.getCurrentAssessment(orgId, caseId),
      store.listCasePoLines(orgId, caseId),
      store.listQuotes(orgId, caseId),
      store.listOffers(orgId, caseId),
      store.listActions(orgId, caseId),
      store.listApprovedSuppliers(orgId, caseRow.item_id),
      store.getCurrentPolicy(orgId),
      store.listCaseEvidence(orgId, caseId),
    ]);

  const emailsBySupplier = new Map<string, number>();
  const callsBySupplier = new Map<string, number>();
  const contactedSuppliers = new Set<string>();
  let calls = 0;
  for (const action of actions) {
    const supplierId = action.payload?.supplier_id as string | undefined;
    if (action.kind === "supplier_email") {
      if (supplierId) {
        emailsBySupplier.set(
          supplierId,
          (emailsBySupplier.get(supplierId) ?? 0) + 1,
        );
        contactedSuppliers.add(supplierId);
      }
    } else if (action.kind === "supplier_call") {
      calls += 1;
      if (supplierId) {
        callsBySupplier.set(
          supplierId,
          (callsBySupplier.get(supplierId) ?? 0) + 1,
        );
        contactedSuppliers.add(supplierId);
      }
    }
  }
  const queries = await store.countResearchQueries(orgId, caseId, ctx.episode);
  const pageReads = await store.countPageReads(orgId, caseId, ctx.episode);
  const episodeRequests = await store.countPlannerRequests(
    orgId,
    caseId,
    ctx.episode,
  );

  const contacts = suppliers.flatMap(({ supplier, contacts }) =>
    contacts.map((c) => ({
      id: c.id,
      supplier_id: supplier.id,
      supplier_name: supplier.name,
      channel: c.channel,
      timezone: c.timezone,
      display_name: c.display_name,
    })),
  );

  const excerptEntries = evidence
    .filter((e) => e.supported_excerpt)
    .map((e) => ({
      evidence_id: e.id,
      untrusted_supplier_text: (e.supported_excerpt ?? "").slice(0, EXCERPT_CAP),
    }));

  const context: Record<string, unknown> = {
    case: {
      id: caseRow.id,
      phase: caseRow.phase,
      run_control: caseRow.run_control,
      episode: caseRow.episode,
      row_version: caseRow.row_version,
      assessment_version: assessment?.version ?? null,
      timezone: location?.timezone ?? null,
      destination_location_id: caseRow.location_id,
      next_deadline: caseRow.next_check_at,
    },
    item: item
      ? {
          id: item.id,
          sku: item.sku,
          description: item.description,
          base_unit: item.base_unit,
          specification: item.specification,
        }
      : null,
    po_lines: poLines.map((l) => ({
      po_line_id: l.po_line_id,
      order_ref: l.purchase_order_external_id,
      ordered_qty: l.ordered_qty,
      received_qty: l.received_qty,
      cancelled_qty: l.cancelled_qty,
      original_due_at: l.original_due_at,
      promises: l.schedules.map((s) => ({
        quantity_remaining: s.quantity_remaining,
        earliest_at: s.earliest_at,
        latest_at: s.latest_at,
        promise_state: s.promise_state,
      })),
    })),
    shortage: assessment
      ? {
          quality: assessment.quality,
          first_shortage_at: assessment.first_shortage_at,
          bridge_qty: assessment.bridge_qty,
          requirements: assessment.dated_requirements,
          source_as_of: assessment.source_as_of,
        }
      : null,
    offers: offers.map((o) => ({
      offer_id: o.id,
      supplier_id: o.supplier_id,
      evidence_ids: o.evidence_ids,
    })),
    quotes: quotes.map((q) => ({
      quote_id: q.id,
      supplier_id: q.supplier_id,
      status: q.status,
      quantity: q.quantity,
      unit: q.unit,
      arrival_start: q.arrival_start,
      arrival_end: q.arrival_end,
      valid_until: q.valid_until,
      missing_evidence: q.evidence_ids.length === 0,
    })),
    outreach_contacts: contacts,
    attempted_actions: actions.map((a) => ({
      action_id: a.id,
      kind: a.kind,
      state: a.state,
      supplier_id: a.payload?.supplier_id ?? null,
    })),
    remaining_budgets: {
      model_requests_episode: Math.max(
        0,
        limits.modelRequestsPerEpisode - episodeRequests,
      ),
      search_queries: Math.max(0, limits.searchQueriesPerEpisode - queries),
      distinct_pages: Math.max(0, limits.distinctPagesPerEpisode - pageReads),
      calls_episode: Math.max(0, limits.callsPerEpisode - calls),
      distinct_suppliers: Math.max(
        0,
        limits.distinctSuppliersPerEpisode - contactedSuppliers.size,
      ),
    },
    phase: caseRow.phase,
    allowed_tools: allowedTools(caseRow.phase),
    policy: policy
      ? {
          procurement_ceiling_minor:
            (policy.settings as Record<string, unknown>)
              .procurement_ceiling_minor ?? null,
        }
      : null,
    evidence_excerpts: excerptEntries,
    generated_at: clock.now().toISOString(),
  };

  // Hard cap: drop oldest excerpts first.
  while (
    excerptEntries.length > 0 &&
    JSON.stringify(context).length > CAP
  ) {
    excerptEntries.shift();
  }
  return context;
}
