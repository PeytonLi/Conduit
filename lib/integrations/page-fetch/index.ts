import type { Clock } from "@/lib/agent/clock";
import { createPageFetcher, type PageFetcher, type PageFetcherDeps } from "./fetcher";
import { parseHostAllowlist } from "./ssrf";

export * from "./fetcher";
export { isBlockedAddress, parseHostAllowlist, validateFetchUrl, hostAllowed } from "./ssrf";

export interface PageFetchEnv {
  DIRECT_PAGE_FETCH_ENABLED?: string;
  DIRECT_PAGE_FETCH_ALLOWLIST?: string;
}

/**
 * The direct fetcher is off unless DIRECT_PAGE_FETCH_ENABLED is exactly "true"
 * and the app is outside replay mode. Replay mode never touches the network
 * (AT-33), so the planner never sees the tool there.
 */
export function selectPageFetcher(
  env: PageFetchEnv,
  mode: "replay" | "sandbox" | "live",
  deps: { clock: Clock } & Pick<PageFetcherDeps, "resolve" | "transport" | "limits">,
): PageFetcher | undefined {
  if (mode === "replay" || env.DIRECT_PAGE_FETCH_ENABLED !== "true") return undefined;
  return createPageFetcher({
    ...deps,
    allowlist: parseHostAllowlist(env.DIRECT_PAGE_FETCH_ALLOWLIST),
  });
}
