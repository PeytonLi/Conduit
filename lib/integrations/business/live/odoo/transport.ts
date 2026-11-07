import { z } from "zod";

export const odooCredentialsSchema = z.object({
  url: z
    .string()
    .trim()
    .url()
    .transform((url) => url.replace(/\/+$/, "")),
  database: z.string().trim().min(1).max(63),
  username: z.string().trim().min(1).max(254),
  api_key: z.string().trim().min(16).max(256),
});

export type OdooCredentials = z.infer<typeof odooCredentialsSchema>;

/** Odoo answered with an error (access, validation, missing record). The request did not apply. */
export class OdooRpcError extends Error {
  constructor(
    readonly status: number,
    readonly odooName: string,
    message: string,
  ) {
    super(message);
    this.name = "OdooRpcError";
  }
}

/** No usable answer (network, timeout, 5xx, malformed body): a write may or may not have applied. */
export class OdooTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OdooTransportError";
  }
}

const errorBodySchema = z.object({ name: z.string().optional(), message: z.string().optional() }).passthrough();
const versionSchema = z
  .object({
    version: z.string().optional(),
    server_version: z.string().optional(),
    version_info: z.array(z.union([z.number(), z.string()])).min(1).optional(),
    server_version_info: z.array(z.union([z.number(), z.string()])).min(1).optional(),
  })
  .transform((v) => ({ version: v.version ?? v.server_version, info: v.version_info ?? v.server_version_info }))
  .refine((v) => v.version !== undefined && v.info !== undefined);

export interface OdooTransport {
  call<T extends z.ZodType>(model: string, method: string, body: Record<string, unknown>, schema: T): Promise<z.infer<T>>;
  version(): Promise<{ server_version: string; major: number }>;
}

/** Odoo 19+ external JSON-2 API (POST /json/2/<model>/<method>, bearer API key). */
export function createOdooTransport(
  credentials: OdooCredentials,
  deps: { fetch?: typeof fetch; timeoutMs?: number } = {},
): OdooTransport {
  const doFetch = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 20_000;

  const send = async (path: string, init: RequestInit): Promise<Response> => {
    try {
      return await doFetch(`${credentials.url}${path}`, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new OdooTransportError(error instanceof Error ? `Odoo request failed: ${error.name}` : "Odoo request failed");
    }
  };

  return {
    async call(model, method, body, schema) {
      const response = await send(`/json/2/${model}/${method}`, {
        method: "POST",
        headers: {
          Authorization: `bearer ${credentials.api_key}`,
          "X-Odoo-Database": credentials.database,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        throw new OdooTransportError(`Odoo returned a non-JSON body (HTTP ${response.status})`);
      }
      if (!response.ok) {
        if (response.status >= 500 && response.status !== 501) {
          throw new OdooTransportError(`Odoo returned HTTP ${response.status}`);
        }
        const parsed = errorBodySchema.safeParse(json);
        throw new OdooRpcError(
          response.status,
          parsed.success ? (parsed.data.name ?? "unknown") : "unknown",
          parsed.success ? (parsed.data.message ?? `HTTP ${response.status}`) : `HTTP ${response.status}`,
        );
      }
      const parsed = schema.safeParse(json);
      if (!parsed.success) throw new OdooTransportError(`Unexpected Odoo response for ${model}.${method}`);
      return parsed.data;
    },
    async version() {
      const response = await send("/web/version", { method: "GET" });
      if (!response.ok) throw new OdooTransportError(`Odoo /web/version returned HTTP ${response.status}`);
      const parsed = versionSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) throw new OdooTransportError("Odoo /web/version returned an unexpected body");
      const head = parsed.data.info![0];
      const major = typeof head === "number" ? head : Number.parseInt(String(head).replace(/^saas~/, ""), 10);
      return { server_version: parsed.data.version!, major };
    },
  };
}
