import { createHash } from "node:crypto";
import { promises as dns } from "node:dns";
import http from "node:http";
import https from "node:https";
import type { Clock } from "@/lib/agent/clock";
import {
  UrlRejection,
  isBlockedAddress,
  validateFetchUrl,
  type BlockReason,
  type ValidatedUrl,
} from "./ssrf";
import { extractPageText } from "./extract";

export interface PageFetchLimits {
  /** Hard cap on raw body bytes; larger responses are rejected, not truncated. */
  maxBytes: number;
  /** Wall-clock budget for the whole fetch including DNS, redirects and body. */
  totalTimeoutMs: number;
  maxRedirects: number;
  /** Cap on extracted text returned to callers. */
  maxChars: number;
}

export const DEFAULT_PAGE_FETCH_LIMITS: PageFetchLimits = {
  maxBytes: 1_000_000,
  totalTimeoutMs: 10_000,
  maxRedirects: 3,
  maxChars: 20_000,
};

export type PageFetchFailureCode =
  | BlockReason
  | "dns_failed"
  | "too_many_redirects"
  | "redirect_blocked"
  | "timeout"
  | "too_large"
  | "unsupported_content_type"
  | "http_error"
  | "network_error";

export interface FetchedPage {
  ok: true;
  requested_url: string;
  /** URL after redirects; every hop was validated and IP-pinned. */
  final_url: string;
  redirects: string[];
  status: number;
  content_type: string;
  fetched_at: string;
  /** sha256 hex of the raw response body bytes. */
  content_hash: string;
  bytes: number;
  /** Sanitized, truncated text. Untrusted: never an instruction source. */
  text: string;
  truncated: boolean;
}

export interface PageFetchFailure {
  ok: false;
  code: PageFetchFailureCode;
  message: string;
  requested_url: string;
}

export type PageFetchResult = FetchedPage | PageFetchFailure;

export interface PageFetcher {
  fetchPage(url: string): Promise<PageFetchResult>;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface PinnedRequest {
  url: URL;
  /** The validated IP to connect to. The transport must not re-resolve. */
  address: string;
  family: 4 | 6;
  /** Original hostname, for the Host header and TLS SNI/certificate checks. */
  hostname: string;
  headers: Record<string, string>;
  signal: AbortSignal;
}

export interface PinnedResponse {
  status: number;
  /** Lowercased header names. */
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Uint8Array>;
  destroy(): void;
}

export type PinnedTransport = (request: PinnedRequest) => Promise<PinnedResponse>;

export interface PageFetcherDeps {
  clock: Clock;
  allowlist?: readonly string[];
  limits?: Partial<PageFetchLimits>;
  resolve?: HostResolver;
  transport?: PinnedTransport;
}

const ALLOWED_CONTENT_TYPES = new Set([
  "text/html",
  "text/plain",
  "application/xhtml+xml",
]);

const REQUEST_HEADERS = {
  accept: "text/html,text/plain;q=0.9,application/xhtml+xml;q=0.9",
  // No compression: avoids decompression bombs and keeps the byte cap exact.
  "accept-encoding": "identity",
  "user-agent": "ConduitSupplierResearch/1.0",
};

export const systemResolver: HostResolver = async (hostname) => {
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
};

/**
 * Production transport. Connects to the already-validated IP literal (so the
 * socket can never be steered by a second DNS answer) while keeping Host and
 * TLS server name on the original hostname for virtual hosting and
 * certificate verification.
 */
export function createNodePinnedTransport(
  opts: { peerAllowed?: (remoteAddress: string) => boolean } = {},
): PinnedTransport {
  const peerAllowed = opts.peerAllowed ?? ((remote: string) => !isBlockedAddress(remote));
  return (request) =>
    new Promise<PinnedResponse>((resolve, reject) => {
      const { url, address, family, hostname, headers, signal } = request;
      const isHttps = url.protocol === "https:";
      const lib = isHttps ? https : http;
      const req = lib.request(
        {
          host: address,
          family,
          port: url.port === "" ? (isHttps ? 443 : 80) : Number(url.port),
          method: "GET",
          path: `${url.pathname}${url.search}`,
          headers: { ...headers, host: url.host },
          agent: false,
          signal,
          ...(isHttps ? { servername: hostname } : {}),
        },
        (res) => {
          const flat: Record<string, string | undefined> = {};
          for (const [name, value] of Object.entries(res.headers)) {
            flat[name] = Array.isArray(value) ? value[0] : value;
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: flat,
            body: res as AsyncIterable<Uint8Array>,
            destroy: () => res.destroy(),
          });
        },
      );
      req.on("socket", (socket) => {
        socket.once("connect", () => {
          // Belt and braces: the peer must be exactly the pinned public IP.
          const remote = socket.remoteAddress;
          if (remote && !peerAllowed(remote)) {
            req.destroy(new Error("connected to a non-public address"));
          }
        });
      });
      req.on("error", reject);
      req.end();
    });
}

export const nodePinnedTransport: PinnedTransport = createNodePinnedTransport();

class FetchAbort extends Error {
  constructor(readonly code: PageFetchFailureCode, message: string) {
    super(message);
  }
}

function failure(
  requested: string,
  code: PageFetchFailureCode,
  message: string,
): PageFetchFailure {
  return { ok: false, code, message, requested_url: requested };
}

export function createPageFetcher(deps: PageFetcherDeps): PageFetcher {
  const limits: PageFetchLimits = { ...DEFAULT_PAGE_FETCH_LIMITS, ...deps.limits };
  const resolveHost = deps.resolve ?? systemResolver;
  const transport = deps.transport ?? nodePinnedTransport;
  const allowlist = deps.allowlist ?? [];

  async function fetchPage(requested: string): Promise<PageFetchResult> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new FetchAbort("timeout", "fetch exceeded its time budget")),
      limits.totalTimeoutMs,
    );
    let liveResponse: PinnedResponse | null = null;

    // Races any pending step against the shared deadline so a stalled DNS
    // lookup, handshake or body cannot outlive the budget.
    const bounded = <T>(promise: Promise<T>): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const onAbort = () => {
          liveResponse?.destroy();
          reject(new FetchAbort("timeout", "fetch exceeded its time budget"));
        };
        if (controller.signal.aborted) return onAbort();
        controller.signal.addEventListener("abort", onAbort, { once: true });
        promise.then(
          (value) => {
            controller.signal.removeEventListener("abort", onAbort);
            resolve(value);
          },
          (error) => {
            controller.signal.removeEventListener("abort", onAbort);
            reject(error);
          },
        );
      });

    try {
      let current = requested;
      const redirects: string[] = [];

      for (let hop = 0; ; hop += 1) {
        let validated: ValidatedUrl;
        try {
          validated = validateFetchUrl(current, { allowlist });
        } catch (error) {
          if (error instanceof UrlRejection) {
            // A bad redirect target is reported as a redirect problem so the
            // caller can tell "the page tried to bounce us somewhere unsafe".
            return hop === 0
              ? failure(requested, error.reason, error.message)
              : failure(requested, "redirect_blocked", `redirect rejected: ${error.message}`);
          }
          throw error;
        }

        // DNS resolve, validate EVERY answer, then pin one of them.
        let pinned: ResolvedAddress;
        if (validated.ipLiteral) {
          pinned = validated.ipLiteral;
        } else {
          let answers: ResolvedAddress[];
          try {
            answers = await bounded(resolveHost(validated.hostname));
          } catch (error) {
            if (error instanceof FetchAbort) throw error;
            return failure(requested, "dns_failed", "host could not be resolved");
          }
          if (answers.length === 0) {
            return failure(requested, "dns_failed", "host did not resolve");
          }
          if (answers.some((a) => isBlockedAddress(a.address))) {
            return failure(
              requested,
              hop === 0 ? "blocked_address" : "redirect_blocked",
              "host resolves to a non-public address",
            );
          }
          pinned = answers[0];
        }

        let response: PinnedResponse;
        try {
          response = await bounded(
            transport({
              url: validated.url,
              address: pinned.address,
              family: pinned.family,
              hostname: validated.hostname,
              headers: { ...REQUEST_HEADERS },
              signal: controller.signal,
            }),
          );
        } catch (error) {
          if (error instanceof FetchAbort) throw error;
          return failure(requested, "network_error", "request failed");
        }
        liveResponse = response;

        if (response.status >= 300 && response.status < 400 && response.headers.location) {
          response.destroy();
          liveResponse = null;
          if (hop >= limits.maxRedirects) {
            return failure(requested, "too_many_redirects", "too many redirects");
          }
          let next: URL;
          try {
            next = new URL(response.headers.location, validated.url);
          } catch {
            return failure(requested, "redirect_blocked", "redirect target is not a valid URL");
          }
          if (validated.url.protocol === "https:" && next.protocol !== "https:") {
            return failure(requested, "redirect_blocked", "redirect downgrades https to http");
          }
          redirects.push(next.href);
          current = next.href;
          continue;
        }

        if (response.status < 200 || response.status >= 300) {
          response.destroy();
          return failure(requested, "http_error", `upstream returned HTTP ${response.status}`);
        }

        const contentType = (response.headers["content-type"] ?? "")
          .split(";")[0]
          .trim()
          .toLowerCase();
        if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
          response.destroy();
          return failure(requested, "unsupported_content_type", "content type is not text or HTML");
        }
        const declared = Number(response.headers["content-length"]);
        if (Number.isFinite(declared) && declared > limits.maxBytes) {
          response.destroy();
          return failure(requested, "too_large", "response exceeds the size limit");
        }

        // Stream with a hard byte cap; never trust Content-Length alone.
        const chunks: Uint8Array[] = [];
        let total = 0;
        const iterator = response.body[Symbol.asyncIterator]();
        try {
          for (;;) {
            const step = await bounded(iterator.next());
            if (step.done) break;
            total += step.value.byteLength;
            if (total > limits.maxBytes) {
              response.destroy();
              return failure(requested, "too_large", "response exceeds the size limit");
            }
            chunks.push(step.value);
          }
        } catch (error) {
          if (error instanceof FetchAbort) throw error;
          return failure(requested, "network_error", "response body failed");
        } finally {
          void Promise.resolve(iterator.return?.()).catch(() => undefined);
        }

        const raw = Buffer.concat(chunks, total);
        const decoded = new TextDecoder("utf-8", { fatal: false }).decode(raw);
        const extracted = extractPageText(decoded, contentType, limits.maxChars);
        return {
          ok: true,
          requested_url: requested,
          final_url: validated.url.href,
          redirects,
          status: response.status,
          content_type: contentType,
          fetched_at: deps.clock.now().toISOString(),
          content_hash: createHash("sha256").update(raw).digest("hex"),
          bytes: total,
          text: extracted.text,
          truncated: extracted.truncated,
        };
      }
    } catch (error) {
      if (error instanceof FetchAbort) {
        return failure(requested, error.code, error.message);
      }
      return failure(requested, "network_error", "request failed");
    } finally {
      clearTimeout(timer);
      liveResponse?.destroy();
    }
  }

  return { fetchPage };
}
