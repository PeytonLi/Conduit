import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerClient } from "@/lib/db/server";

export interface QueryContext {
  orgId: string;
  userId: string;
  role: "owner" | "operator" | "viewer";
  client?: SupabaseClient;
}

export async function queryClient(context: QueryContext): Promise<SupabaseClient> {
  return context.client ?? createServerClient();
}

export class QueryError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "QueryError";
  }
}

export function assertQuery<T>(
  data: T | null,
  error: { message: string; code?: string | null } | null,
): T {
  if (error) {
    throw new QueryError("query_failed", 503, "The requested data is temporarily unavailable");
  }
  if (data === null) {
    throw new QueryError("not_found", 404, "The requested resource was not found");
  }
  return data;
}
