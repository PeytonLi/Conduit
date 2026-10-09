import type { Clock } from "@/lib/agent/clock";

export interface ExaSearchResult {
  url: string;
  title: string | null;
  published_at: string | null;
  retrieved_at: string;
  excerpt: string;
  excerpt_hash: string;
}

export interface SupplierSearchResponse {
  results: ExaSearchResult[];
  provider_request_id: string;
  cost_usd: string | null;
}

export interface SupplierContentsResponse {
  pages: { url: string; text: string }[];
  provider_request_id: string;
  cost_usd: string | null;
}

export interface SupplierResearch {
  search(
    query: string,
    opts: { numResults: number },
  ): Promise<SupplierSearchResponse>;
  contents(
    urls: string[],
    opts: { maxCharacters: number },
  ): Promise<SupplierContentsResponse>;
}

export class ExaApiError extends Error {
  readonly status: number;

  constructor(status: number, message = "Exa request failed") {
    super(message);
    this.name = "ExaApiError";
    this.status = status;
  }
}

export type FetchImpl = (
  input: string | URL,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string,
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface ExaDeps {
  apiKey: string;
  fetchImpl?: FetchImpl;
  clock: Clock;
  baseUrl?: string;
}

const SEARCH_MAX_RESULTS = 5;
const SEARCH_MAX_CHARS = 1000;
const CONTENTS_MAX_CHARS = 20_000;

function costToString(costDollars: unknown): string | null {
  if (costDollars === null || costDollars === undefined) return null;
  if (typeof costDollars === "number") return String(costDollars);
  const total = (costDollars as { total?: unknown }).total;
  return typeof total === "number" ? String(total) : null;
}

export function createExaResearch(deps: ExaDeps): SupplierResearch {
  const fetchImpl: FetchImpl =
    deps.fetchImpl ??
    ((input, init) =>
      fetch(input, init as RequestInit) as Promise<{
        ok: boolean;
        status: number;
        json(): Promise<unknown>;
      }>);
  const baseUrl = deps.baseUrl ?? "https://api.exa.ai";

  async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "x-api-key": deps.apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new ExaApiError(response.status);
    }
    return (await response.json()) as T;
  }

  return {
    async search(query, { numResults }) {
      const body = {
        query,
        type: "auto",
        numResults: Math.min(numResults, SEARCH_MAX_RESULTS),
        contents: { text: { maxCharacters: SEARCH_MAX_CHARS } },
      };
      const data = await post<{
        requestId?: string;
        results?: {
          url?: string;
          title?: string;
          publishedDate?: string | null;
          text?: string;
        }[];
        costDollars?: unknown;
      }>("/search", body);
      const retrieved_at = deps.clock.now().toISOString();
      const results: ExaSearchResult[] = (data.results ?? []).map((result) => {
        const excerpt = (result.text ?? "").slice(0, SEARCH_MAX_CHARS);
        return {
          url: result.url ?? "",
          title: result.title ?? null,
          published_at: result.publishedDate ?? null,
          retrieved_at,
          excerpt,
          excerpt_hash: "",
        };
      });
      return {
        results,
        provider_request_id: data.requestId ?? "",
        cost_usd: costToString(data.costDollars),
      };
    },

    async contents(urls, { maxCharacters }) {
      const limit = Math.min(maxCharacters, CONTENTS_MAX_CHARS);
      const data = await post<{
        requestId?: string;
        results?: { url?: string; text?: string }[];
        costDollars?: unknown;
      }>("/contents", { urls, text: { maxCharacters: limit } });
      return {
        pages: (data.results ?? []).map((page) => ({
          url: page.url ?? "",
          text: (page.text ?? "").slice(0, limit),
        })),
        provider_request_id: data.requestId ?? "",
        cost_usd: costToString(data.costDollars),
      };
    },
  };
}
