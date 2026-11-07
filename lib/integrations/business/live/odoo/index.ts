import { z } from "zod";
import type { ErpProviderDefinition } from "../types";
import { createOdooErpClient } from "./client";
import { createOdooTransport, odooCredentialsSchema, OdooRpcError, OdooTransportError, type OdooCredentials } from "./transport";

export { createOdooErpClient } from "./client";
export { createOdooTransport, odooCredentialsSchema, OdooRpcError, OdooTransportError, type OdooCredentials } from "./transport";

/** Odoo 19+ only: the JSON-2 API this client uses does not exist before 19. */
export const MIN_ODOO_MAJOR = 19;

export const odooProvider: ErpProviderDefinition = {
  provider: "odoo",
  label: "Odoo",
  createClient(credentials, deps) {
    const parsed = odooCredentialsSchema.parse(credentials);
    return createOdooErpClient(createOdooTransport(parsed, { fetch: deps?.fetch }), { now: deps?.now });
  },
};

export type OdooVerifyResult =
  | { ok: true; externalAccountId: string; serverVersion: string; userId: number }
  | { ok: false; code: "unreachable" | "unsupported_version" | "invalid_credentials" | "login_mismatch" | "missing_access"; message: string };

/** Calls Odoo with the submitted credentials: version, API key, matching login and read access. */
export async function verifyOdooConnection(
  credentials: OdooCredentials,
  deps: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<OdooVerifyResult> {
  const transport = createOdooTransport(credentials, { fetch: deps.fetch, timeoutMs: deps.timeoutMs ?? 10_000 });
  let version: { server_version: string; major: number };
  try {
    version = await transport.version();
  } catch {
    return { ok: false, code: "unreachable", message: "Could not reach Odoo at that address" };
  }
  if (!(version.major >= MIN_ODOO_MAJOR)) {
    return { ok: false, code: "unsupported_version", message: `Odoo ${version.server_version} is too old; version ${MIN_ODOO_MAJOR} or newer is needed` };
  }
  try {
    const context = await transport.call("res.users", "context_get", {}, z.object({ uid: z.number().int() }).passthrough());
    const [user] = await transport.call("res.users", "read", { ids: [context.uid], fields: ["login"] }, z.array(z.object({ id: z.number().int(), login: z.string() })).length(1));
    if (user.login.toLowerCase() !== credentials.username.toLowerCase()) {
      return { ok: false, code: "login_mismatch", message: "That API key belongs to a different Odoo user" };
    }
    for (const model of ["purchase.order", "purchase.order.line", "stock.quant", "stock.move"]) {
      await transport.call(model, "search_count", { domain: [], limit: 1 }, z.number().int());
    }
    return { ok: true, externalAccountId: `${new URL(credentials.url).host}/${credentials.database}`, serverVersion: version.server_version, userId: user.id };
  } catch (error) {
    if (error instanceof OdooRpcError && error.status === 401) {
      return { ok: false, code: "invalid_credentials", message: "Odoo rejected the database or API key" };
    }
    if (error instanceof OdooRpcError && error.status === 403) {
      return { ok: false, code: "missing_access", message: "That Odoo user cannot read purchasing and inventory" };
    }
    if (error instanceof OdooRpcError || error instanceof OdooTransportError) {
      return { ok: false, code: "unreachable", message: "Odoo did not accept the request" };
    }
    throw error;
  }
}

const PRIVATE_HOST = /^(localhost|.*\.localhost|.*\.internal|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[?::1\]?|\[?f[cd][0-9a-f:]*\]?)$/i;

/** Hosted Conduit only calls public https Odoo addresses; plain http and local hosts are for local runs. */
export function odooUrlAllowed(url: string, production: boolean): boolean {
  const parsed = new URL(url);
  if (parsed.username || parsed.password) return false;
  if (!production) return parsed.protocol === "https:" || parsed.protocol === "http:";
  return parsed.protocol === "https:" && !PRIVATE_HOST.test(parsed.hostname);
}
