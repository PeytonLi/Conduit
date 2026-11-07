import { createHash } from "node:crypto";
import type { z } from "zod";
import { QBO_MINOR_VERSION, qboApiBaseUrl } from "./config";
import { credentialsFromTokens, refreshQboToken } from "./oauth";
import { qboEntitySchemas, qboFaultSchema, type QboCredentials, type QboEntity, type QboEntityName } from "./schemas";

/** QBO's fault code for a write sent with an old SyncToken. */
export const QBO_STALE_OBJECT = "5010";
export const QBO_OBJECT_NOT_FOUND = "610";

export class QboFaultError extends Error {
  constructor(
    readonly status: number,
    readonly codes: string[],
    message: string,
  ) {
    super(message);
    this.name = "QboFaultError";
  }
}

/** The request may or may not have reached QuickBooks (network error, timeout, 5xx). */
export class QboTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QboTransportError";
  }
}

export type SaveQboCredentials = (next: QboCredentials, previous: QboCredentials) => Promise<"saved" | "superseded">;

export interface QboHttpDeps {
  clientId: string;
  clientSecret: string;
  credentials: QboCredentials;
  fetch: typeof fetch;
  now: () => Date;
  saveCredentials?: SaveQboCredentials;
}

/** Quotes a value for the QBO query language. */
export function qboLiteral(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** QBO's `requestid` makes a retried create/update return the first response instead of writing twice. */
export function qboRequestId(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 40);
}

export function createQboHttp(deps: QboHttpDeps) {
  let credentials = deps.credentials;
  const base = `${qboApiBaseUrl(credentials.environment)}/v3/company/${credentials.realm_id}`;

  let refreshing: Promise<string> | null = null;

  /** One refresh at a time: a rotated refresh token invalidates the one parallel calls would send. */
  function refresh(): Promise<string> {
    refreshing ??= (async () => {
      const previous = credentials;
      const tokens = await refreshQboToken(
        { refreshToken: previous.refresh_token, clientId: deps.clientId, clientSecret: deps.clientSecret },
        deps.fetch,
      );
      credentials = credentialsFromTokens(tokens, previous, deps.now());
      if (deps.saveCredentials) await deps.saveCredentials(credentials, previous);
      return credentials.access_token!;
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  async function accessToken(rejected?: string): Promise<string> {
    if (refreshing) return refreshing;
    const current = credentials.access_token;
    const expiresAt = credentials.access_token_expires_at ? Date.parse(credentials.access_token_expires_at) : 0;
    if (current && current !== rejected && expiresAt - 60_000 > deps.now().getTime()) return current;
    return refresh();
  }

  async function send(method: "GET" | "POST", path: string, params: Record<string, string>, body?: unknown): Promise<unknown> {
    const url = new URL(`${base}/${path}`);
    for (const [k, v] of Object.entries({ ...params, minorversion: QBO_MINOR_VERSION })) url.searchParams.set(k, v);
    let rejected: string | undefined;
    for (let attempt = 0; ; attempt++) {
      const token = await accessToken(rejected);
      let response: Response;
      try {
        response = await deps.fetch(url, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (err) {
        throw new QboTransportError(`QuickBooks request failed: ${err instanceof Error ? err.message : "network error"}`);
      }
      if (response.status === 401 && attempt === 0) {
        rejected = token;
        continue;
      }
      const json = await response.json().catch(() => null);
      const fault = qboFaultSchema.safeParse(json);
      if (fault.success) {
        const errors = fault.data.Fault.Error;
        throw new QboFaultError(
          response.status,
          errors.map((e) => e.code ?? ""),
          errors.map((e) => e.Message ?? e.Detail ?? "QuickBooks error").join("; "),
        );
      }
      if (response.status >= 500) throw new QboTransportError(`QuickBooks returned HTTP ${response.status}`);
      if (!response.ok || json === null) throw new QboFaultError(response.status, [], `QuickBooks returned HTTP ${response.status}`);
      return json;
    }
  }

  function pick<N extends QboEntityName>(name: N, json: unknown): QboEntity<N> {
    const schema = qboEntitySchemas[name] as unknown as z.ZodType<QboEntity<N>>;
    return schema.parse((json as Record<string, unknown>)[name]);
  }

  return {
    get credentials() {
      return credentials;
    },
    async query<N extends QboEntityName>(name: N, where: string): Promise<QboEntity<N>[]> {
      const schema = qboEntitySchemas[name] as unknown as z.ZodType<QboEntity<N>>;
      const rows: QboEntity<N>[] = [];
      const page = 1000;
      for (let start = 1; ; start += page) {
        const query = `select * from ${name}${where ? ` where ${where}` : ""} startposition ${start} maxresults ${page}`;
        const json = (await send("GET", "query", { query })) as { QueryResponse?: Record<string, unknown> };
        const batch = (json.QueryResponse?.[name] as unknown[] | undefined) ?? [];
        rows.push(...batch.map((row) => schema.parse(row)));
        if (batch.length < page) return rows;
      }
    },
    async read<N extends QboEntityName>(name: N, id: string): Promise<QboEntity<N> | null> {
      try {
        return pick(name, await send("GET", `${name.toLowerCase()}/${encodeURIComponent(id)}`, {}));
      } catch (err) {
        if (err instanceof QboFaultError && err.codes.includes(QBO_OBJECT_NOT_FOUND)) return null;
        throw err;
      }
    },
    async write<N extends QboEntityName>(name: N, body: Record<string, unknown>, requestId: string): Promise<QboEntity<N>> {
      return pick(name, await send("POST", name.toLowerCase(), { requestid: requestId }, body));
    },
  };
}
export type QboHttp = ReturnType<typeof createQboHttp>;
