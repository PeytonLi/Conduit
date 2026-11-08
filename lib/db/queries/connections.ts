import { capabilities, parseServerEnv } from "@/lib/env";
import { QueryError, type QueryContext, queryClient } from "./client";

const safeConnectionMessages: Record<string, string> = {
  auth_expired: "Reconnect this account",
  permission_denied: "The provider denied required access",
  sync_failed: "The latest sync did not complete",
  rate_limited: "The provider is temporarily rate limiting requests",
  // Codes written by the mailbox pollers (Gmail and Outlook).
  invalid_grant: "Reconnect this account",
  expired: "Reconnect this account",
  invalid_request: "The provider denied required access",
  transient: "The latest sync did not complete",
};

export interface ConnectionSummary {
  id: string;
  provider: string;
  /** Mailbox address for Gmail/Outlook; the account identifier for other providers. */
  external_account_id: string | null;
  /** True for the mailbox used by default for outbound supplier email. */
  is_primary: boolean;
  status: string;
  last_success_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  capabilities: Record<string, boolean>;
}

export interface ConnectionsResult {
  connections: ConnectionSummary[];
  environment_capabilities: ReturnType<typeof capabilities>;
}

export async function listConnections(context: QueryContext): Promise<ConnectionsResult> {
  const client = await queryClient(context);
  const { data, error } = await client.from("connections")
    .select(
      "id,provider,external_account_id,is_primary,status,last_success_at,last_error_code,capabilities",
    )
    .eq("org_id", context.orgId)
    .order("provider", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) {
    throw new QueryError("query_failed", 503, "Connection status is temporarily unavailable");
  }
  const envCapabilities = capabilities(parseServerEnv(process.env));
  return {
    connections: (data ?? []).map((row) => ({
      id: row.id,
      provider: row.provider,
      external_account_id: row.external_account_id ?? null,
      is_primary: row.is_primary === true,
      status: row.status,
      last_success_at: row.last_success_at,
      last_error_code: row.last_error_code,
      last_error_message: row.last_error_code
        ? safeConnectionMessages[row.last_error_code] ?? "The provider reported a connection issue"
        : null,
      capabilities: Object.fromEntries(
        Object.entries(row.capabilities ?? {}).map(([key, value]) => [key, value === true]),
      ),
    })),
    environment_capabilities:
      context.role === "owner"
        ? envCapabilities
        : Object.fromEntries(
            Object.entries(envCapabilities).map(([name, status]) => [
              name,
              { ready: status.ready, missing: [] },
            ]),
          ) as unknown as ReturnType<typeof capabilities>,
  };
}
