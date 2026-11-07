import type { z } from "zod";
import { zohoInventoryBaseUrl, zohoAccountsServer } from "./domains";
import { ZohoApiError, ZohoAuthError, ZohoRateLimitError, ZohoTransportError } from "./errors";
import { zohoEnvelopeSchema, zohoTokenResponseSchema, type ZohoCredentials } from "./schemas";

export interface ZohoHttpConfig {
  credentials: ZohoCredentials;
  clientId: string;
  clientSecret: string;
  fetch: typeof fetch;
  now: () => Date;
}

export type ZohoQuery = Record<string, string | number | undefined>;

export interface ZohoHttp {
  get<T extends z.ZodType>(path: string, schema: T, query?: ZohoQuery): Promise<z.infer<T>>;
  send<T extends z.ZodType>(
    method: "POST" | "PUT" | "DELETE",
    path: string,
    schema: T,
    options?: { query?: ZohoQuery; body?: unknown },
  ): Promise<z.infer<T>>;
}

const TOKEN_EXPIRY_MARGIN_MS = 60_000;

export function createZohoHttp(config: ZohoHttpConfig): ZohoHttp {
  const baseUrl = zohoInventoryBaseUrl(config.credentials.api_domain);
  const accountsServer = zohoAccountsServer(config.credentials.accounts_server);
  if (!baseUrl || !accountsServer) {
    throw new ZohoAuthError("Zoho credential points at an unknown data center");
  }
  let token: { value: string; expiresAt: number } | null = null;

  async function accessToken(): Promise<string> {
    if (token && token.expiresAt > config.now().getTime()) return token.value;
    const body = new URLSearchParams({
      refresh_token: config.credentials.refresh_token,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "refresh_token",
    });
    let response: Response;
    try {
      response = await config.fetch(`${accountsServer}/oauth/v2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
    } catch {
      throw new ZohoTransportError("Zoho token refresh did not complete");
    }
    const parsed = zohoTokenResponseSchema.safeParse(await response.json().catch(() => null));
    if (!response.ok || !parsed.success || "error" in parsed.data) {
      throw new ZohoAuthError("Zoho refused the stored refresh token; reconnect Zoho Inventory");
    }
    const lifetimeMs = (parsed.data.expires_in ?? 3600) * 1000;
    token = {
      value: parsed.data.access_token,
      expiresAt: config.now().getTime() + Math.max(lifetimeMs - TOKEN_EXPIRY_MARGIN_MS, 0),
    };
    return token.value;
  }

  async function request<T extends z.ZodType>(
    method: string,
    path: string,
    schema: T,
    query: ZohoQuery = {},
    body?: unknown,
  ): Promise<z.infer<T>> {
    const url = new URL(`${baseUrl}${path}`);
    url.searchParams.set("organization_id", config.credentials.organization_id);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    for (let attempt = 0; ; attempt += 1) {
      const headers: Record<string, string> = {
        authorization: `Zoho-oauthtoken ${await accessToken()}`,
        accept: "application/json",
      };
      if (body !== undefined) headers["content-type"] = "application/json";
      let response: Response;
      try {
        response = await config.fetch(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch {
        throw new ZohoTransportError(`Zoho ${method} ${path} did not complete`);
      }
      if (response.status === 401 && attempt === 0) {
        token = null;
        continue;
      }
      if (response.status === 429) {
        throw new ZohoRateLimitError("Zoho Inventory rate limit reached; retry later");
      }
      const json: unknown = await response.json().catch(() => null);
      const envelope = zohoEnvelopeSchema.safeParse(json);
      if (!response.ok || !envelope.success || envelope.data.code !== 0) {
        if (response.status >= 500 && method !== "GET") {
          throw new ZohoTransportError(`Zoho ${method} ${path} failed with ${response.status}`);
        }
        throw new ZohoApiError(
          response.status,
          envelope.success ? envelope.data.code : null,
          envelope.success && envelope.data.message
            ? envelope.data.message
            : `Zoho ${method} ${path} failed with ${response.status}`,
        );
      }
      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        throw new ZohoApiError(response.status, 0, `Unexpected Zoho response for ${method} ${path}`);
      }
      return parsed.data;
    }
  }

  return {
    get: (path, schema, query) => request("GET", path, schema, query),
    send: (method, path, schema, options = {}) =>
      request(method, path, schema, options.query, options.body),
  };
}
