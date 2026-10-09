import { createHash } from "node:crypto";
import type { Clock } from "@/lib/agent/clock";
import { createExaResearch } from "./client";
import type {
  ExaSearchResult,
  SupplierContentsResponse,
  SupplierResearch,
  SupplierSearchResponse,
} from "./client";
import fixture from "./fixtures/harbor-discovery.json";

interface FixtureResult {
  url: string;
  title: string;
  published_at: string | null;
  excerpt: string;
}

interface ExaFixture {
  search: {
    provider_request_id: string;
    cost_usd: string;
    results: FixtureResult[];
  };
  contents: {
    provider_request_id: string;
    cost_usd: string;
    pages: Record<string, string>;
  };
}

export function createReplayResearch(
  clock: Clock,
  data: ExaFixture = fixture as ExaFixture,
): SupplierResearch {
  return {
    async search(_query, { numResults }) {
      const retrieved_at = clock.now().toISOString();
      const results: ExaSearchResult[] = data.search.results
        .slice(0, numResults)
        .map((result) => ({
          url: result.url,
          title: result.title,
          published_at: result.published_at,
          retrieved_at,
          excerpt: result.excerpt.slice(0, 1000),
          excerpt_hash: createHash("sha256")
            .update(result.excerpt.slice(0, 1000))
            .digest("hex"),
        }));
      const response: SupplierSearchResponse = {
        results,
        provider_request_id: data.search.provider_request_id,
        cost_usd: data.search.cost_usd,
      };
      return response;
    },

    async contents(urls, { maxCharacters }) {
      const pages = urls
        .filter((url) => url in data.contents.pages)
        .map((url) => ({
          url,
          text: data.contents.pages[url].slice(0, maxCharacters),
        }));
      const response: SupplierContentsResponse = {
        pages,
        provider_request_id: data.contents.provider_request_id,
        cost_usd: data.contents.cost_usd,
      };
      return response;
    },
  };
}

export interface ResearchEnv {
  EXA_API_KEY?: string;
}

/**
 * Replay mode ALWAYS selects the replay adapter, even when a key exists.
 * Live/sandbox requires EXA_API_KEY.
 */
export function selectResearch(
  env: ResearchEnv,
  mode: "replay" | "sandbox" | "live",
  deps: { clock: Clock; fetchImpl?: import("./client").FetchImpl } = { clock: { now: () => new Date(0) } },
): SupplierResearch {
  if (mode === "replay" || !env.EXA_API_KEY) {
    return createReplayResearch(deps.clock);
  }
  // Live adapter only in sandbox/live with a key.
  return createExaResearch({
    apiKey: env.EXA_API_KEY,
    clock: deps.clock,
    fetchImpl: deps.fetchImpl,
  });
}
