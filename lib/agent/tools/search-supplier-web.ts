import { z } from "zod";
import { createHash } from "node:crypto";
import type { AgentTool } from "./types";
import { fail, limitsOf, ok, type ToolDeps } from "./deps";
import { computeCompatibility, CANDIDATE_MISSING_FACTS, specDims } from "../compatibility";

interface Input {
  keywords: string;
  region?: string;
}

const CONTROL_OR_URL = /[\u0000-\u001f\u007f]|https?:\/\/\S+/gi;

export function composeQuery(
  item: { description: string; specification: Record<string, unknown>; base_unit: string },
  keywords: string,
  region?: string,
): string {
  const spec = item.specification ?? {};
  const dims = specDims(spec);
  const dimsText = dims ? `${dims[0]}x${dims[1]}x${dims[2]} mm` : "";
  const material = (spec.material_grade ?? spec.material ?? "") as string;
  const cleanKeywords = keywords.replace(CONTROL_OR_URL, " ").replace(/\s+/g, " ").trim();
  const parts = [
    item.description,
    dimsText,
    material,
    item.base_unit,
    cleanKeywords,
    region ?? "",
  ].filter(Boolean);
  return parts.join(" ").slice(0, 240);
}

export function createSearchSupplierWebTool(
  deps: ToolDeps,
): AgentTool<Input, unknown> {
  return {
    name: "search_supplier_web",
    spanName: "source_retrieval",
    description:
      "Bounded public web search for alternative suppliers. Query is composed by code from the case item spec; results persist as unapproved candidates and research evidence.",
    input: z
      .object({
        keywords: z.string().min(0).max(120),
        region: z.string().max(60).optional(),
      })
      .strict(),
    async run(ctx, input) {
      const limits = limitsOf(deps);
      const c = await deps.store.getCase(ctx.orgId, ctx.caseId);
      if (!c) return fail("not_found", "case not found");
      const item = await deps.store.getItem(ctx.orgId, c.item_id);
      if (!item) return fail("not_found", "item not found");
      const used = await deps.store.countResearchQueries(
        ctx.orgId,
        ctx.caseId,
        c.episode,
      );
      if (used >= limits.searchQueriesPerEpisode) {
        return fail("budget_exhausted", "search query budget exhausted for episode");
      }
      if (!deps.research) {
        return fail("provider_unavailable", "supplier research unavailable");
      }
      const query = composeQuery(item, input.keywords, input.region);
      const response = await deps.research.search(query, {
        numResults: limits.resultsPerQuery,
      });
      const queryRow = await deps.store.insertResearchQuery({
        org_id: ctx.orgId,
        case_id: ctx.caseId,
        episode: c.episode,
        query,
        provider: "exa",
        mode: ctx.mode,
        provider_request_id: response.provider_request_id,
        result_count: response.results.length,
        cost_usd: response.cost_usd,
      });
      const evidenceIds: string[] = [];
      const candidates = [];
      for (const result of response.results.slice(0, limits.resultsPerQuery)) {
        const excerpt = result.excerpt.slice(0, 1000);
        const hash =
          result.excerpt_hash ||
          createHash("sha256").update(excerpt).digest("hex");
        const evidence = await deps.store.insertEvidence({
          org_id: ctx.orgId,
          source_type: "public_web",
          source_url: result.url,
          source_time: result.published_at,
          captured_at: result.retrieved_at,
          content_hash: hash,
          supported_excerpt: excerpt,
        });
        await deps.store.linkCaseEvidence({
          org_id: ctx.orgId,
          case_id: ctx.caseId,
          evidence_id: evidence.id,
          purpose: "research",
        });
        evidenceIds.push(evidence.id);
        const compatibility = computeCompatibility(
          item,
          `${result.title ?? ""} ${excerpt}`,
        );
        const candidate = await deps.store.insertSupplierCandidate({
          org_id: ctx.orgId,
          case_id: ctx.caseId,
          research_query_id: queryRow.id,
          name: result.title,
          domain: (() => {
            try {
              return new URL(result.url).hostname;
            } catch {
              return null;
            }
          })(),
          source_evidence_id: evidence.id,
          compatibility,
          status: "unapproved",
          missing_facts: CANDIDATE_MISSING_FACTS,
        });
        candidates.push({
          candidate_id: candidate.id,
          name: candidate.name,
          domain: candidate.domain,
          source_url: result.url,
          published_at: result.published_at,
          retrieved_at: result.retrieved_at,
          compatibility,
          status: candidate.status,
          missing_facts: candidate.missing_facts,
        });
      }
      return ok(
        {
          query,
          provider_request_id: response.provider_request_id,
          candidates,
        },
        evidenceIds,
      );
    },
  } as AgentTool<Input, unknown>;
}
