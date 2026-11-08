import { GRAPH_HOST } from "./config";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type AppEnvMode = "replay" | "sandbox" | "live";

/** Raised before any network I/O when Microsoft would be contacted from replay. */
export class MicrosoftReplayViolationError extends Error {
  constructor() {
    super("Microsoft is never contacted in replay mode");
    this.name = "MicrosoftReplayViolationError";
  }
}

/**
 * An error response from Microsoft Graph or the Microsoft identity platform.
 * `status` lets the shared mail error classifier treat it like any HTTP error;
 * the message carries only the provider's short error code, never a response body.
 */
export class GraphApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly retryAfterSeconds: number | null;

  constructor(status: number, code: string | null, retryAfterSeconds: number | null = null) {
    super(`Microsoft request failed (${status}${code ? ` ${code}` : ""})`);
    this.name = "GraphApiError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Every Microsoft call (Graph and the token endpoint) goes through this wrapper.
 * `appEnv` is read per call so a mode change is honored immediately, and replay
 * throws before `fetchImpl` is touched.
 */
export function createMicrosoftFetch({
  appEnv,
  fetchImpl = (input, init) => fetch(input, init),
}: {
  appEnv: () => AppEnvMode;
  fetchImpl?: FetchLike;
}): FetchLike {
  return async (input, init) => {
    if (appEnv() === "replay") throw new MicrosoftReplayViolationError();
    return fetchImpl(input, init);
  };
}

/** Graph links (delta and next links) carry the bearer token; only Graph may receive it. */
export function assertGraphUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GraphApiError(400, "invalid_link");
  }
  if (url.protocol !== "https:" || url.hostname !== GRAPH_HOST || url.username || url.password) {
    throw new GraphApiError(400, "invalid_link");
  }
  return url;
}

function safeErrorCode(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as { error?: unknown };
  // Graph: { error: { code } }. Identity platform: { error: "invalid_grant" }.
  const candidate =
    typeof record.error === "string"
      ? record.error
      : record.error && typeof record.error === "object"
        ? (record.error as { code?: unknown }).code
        : null;
  return typeof candidate === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(candidate)
    ? candidate
    : null;
}

export async function toGraphApiError(response: Response): Promise<GraphApiError> {
  let code: string | null = null;
  try {
    code = safeErrorCode(await response.json());
  } catch {
    code = null;
  }
  const retry = Number(response.headers.get("retry-after"));
  return new GraphApiError(
    response.status,
    code,
    Number.isFinite(retry) && retry > 0 ? retry : null,
  );
}

export type MailErrorKind =
  | "invalid_cursor"
  | "revoked"
  | "expired"
  | "rate_limited"
  | "transient"
  | "invalid_request";

/** Mirrors classifyGmailError so the shared sync and dispatch handling applies. */
export function classifyOutlookError(err: unknown): MailErrorKind {
  const e = err as { status?: number; code?: string | null; message?: string };
  const code = typeof e?.code === "string" ? e.code.toLowerCase() : "";
  const message = typeof e?.message === "string" ? e.message : "";
  if (code === "invalid_grant" || code === "interaction_required" || message.includes("invalid_grant")) {
    return "revoked";
  }
  if (e?.status === 410 || code === "syncstatenotfound" || code === "resyncrequired") {
    return "invalid_cursor";
  }
  if (e?.status === 401) return "expired";
  if (e?.status === 429) return "rate_limited";
  if (e?.status !== undefined && e.status >= 500) return "transient";
  if (e?.status !== undefined && e.status >= 400) return "invalid_request";
  return "transient";
}
