import { ErpNotConfiguredError } from "../errors";
import type { ErpProviderDefinition } from "../types";
import { createQuickbooksClient } from "./client";
import { createQboHttp, type SaveQboCredentials } from "./http";
import { qboCredentialsSchema } from "./schemas";

export interface QboClientDeps {
  fetch?: typeof fetch;
  now?: () => Date;
  saveCredentials?: (credentials: unknown, expiresAt: string | null) => Promise<void>;
  env?: Record<string, string | undefined>;
}

export const quickbooksProvider: ErpProviderDefinition = {
  provider: "quickbooks",
  label: "QuickBooks Online",
  createClient(credentials, deps: QboClientDeps = {}) {
    const env = deps.env ?? process.env;
    if (!env.QBO_CLIENT_ID || !env.QBO_CLIENT_SECRET) {
      throw new ErpNotConfiguredError("QBO_CLIENT_ID and QBO_CLIENT_SECRET must be set");
    }
    const now = deps.now ?? (() => new Date());
    const http = createQboHttp({
      clientId: env.QBO_CLIENT_ID,
      clientSecret: env.QBO_CLIENT_SECRET,
      credentials: qboCredentialsSchema.parse(credentials),
      fetch: deps.fetch ?? fetch,
      now,
      saveCredentials: deps.saveCredentials satisfies SaveQboCredentials | undefined,
    });
    return createQuickbooksClient(http, { now });
  },
};

export { readQboConfig } from "./config";
