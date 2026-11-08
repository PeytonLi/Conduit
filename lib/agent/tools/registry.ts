import type { AgentTool } from "./types";
import type { ToolDeps } from "./deps";
import { createReadCaseTool } from "./read-case";
import { createFindOrderCandidatesTool } from "./find-order-candidates";
import { createCalculateShortageTool } from "./calculate-shortage";
import { createListApprovedSuppliersTool } from "./list-approved-suppliers";
import { createSearchSupplierWebTool } from "./search-supplier-web";
import { createReadSupplierSourceTool } from "./read-supplier-source";
import { createEvaluateQuoteTool } from "./evaluate-quote";
import { createRequestSupplierEmailTool } from "./request-supplier-email";
import { createRequestSupplierCallTool } from "./request-supplier-call";
import { createRecordProvisionalOfferTool } from "./record-provisional-offer";
import { createProposeRecoveryPlanTool } from "./propose-recovery-plan";
import { createRequestOwnerReviewTool } from "./request-owner-review";
import { createWaitForEvidenceTool } from "./wait-for-evidence";
import { createFetchPublicPageTool } from "./fetch-public-page";

export const TOOL_NAMES = [
  "read_case",
  "find_order_candidates",
  "calculate_shortage",
  "list_approved_suppliers",
  "search_supplier_web",
  "read_supplier_source",
  "evaluate_quote",
  "request_supplier_email",
  "request_supplier_call",
  "record_provisional_offer",
  "propose_recovery_plan",
  "request_owner_review",
  "wait_for_evidence",
] as const;

/**
 * The 13 F3 tools, plus fetch_public_page only when a page fetcher is
 * configured. No accept/purchase/cancel/amend/execute tool exists.
 */
export function createToolRegistry(
  deps: ToolDeps,
): Map<string, AgentTool<unknown, unknown>> {
  const tools: AgentTool<unknown, unknown>[] = [
    createReadCaseTool(deps),
    createFindOrderCandidatesTool(deps),
    createCalculateShortageTool(deps),
    createListApprovedSuppliersTool(deps),
    createSearchSupplierWebTool(deps),
    createReadSupplierSourceTool(deps),
    createEvaluateQuoteTool(deps),
    createRequestSupplierEmailTool(deps),
    createRequestSupplierCallTool(deps),
    createRecordProvisionalOfferTool(deps),
    createProposeRecoveryPlanTool(deps),
    createRequestOwnerReviewTool(deps),
    createWaitForEvidenceTool(deps),
  ];
  // Optional tool: absent from the registry (and the model's tool list) unless
  // the direct fetcher is enabled, so the 13 core tools stay fixed.
  if (deps.pageFetcher) tools.push(createFetchPublicPageTool(deps));
  return new Map(tools.map((t) => [t.name, t]));
}
