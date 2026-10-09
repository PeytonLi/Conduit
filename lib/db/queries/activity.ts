import { QueryError, type QueryContext, queryClient } from "./client";

export interface ActivityFilters {
  case_id?: string;
  actor?: string;
  outcome?: string;
  limit: number;
  cursor?: string;
}

export interface ActivityEntry {
  id: string;
  at: string;
  case_id: string | null;
  entity_type: string;
  entity_id: string | null;
  event_name: string;
  actor: { type: string; id: string | null };
  outcome: string | null;
  reason: string | null;
  previous_version: number | null;
  new_version: number | null;
}

export interface ActivityPage {
  items: ActivityEntry[];
  next_cursor: string | null;
}

interface ActivityCursor {
  at: string;
  id: string;
}

function decodeCursor(cursor: string): ActivityCursor {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      typeof value === "object" && value !== null &&
      typeof (value as ActivityCursor).at === "string" &&
      typeof (value as ActivityCursor).id === "string"
    ) return value as ActivityCursor;
  } catch {
    // Malformed cursors return a safe validation error.
  }
  throw new QueryError("invalid_cursor", 422, "Activity cursor is invalid");
}

export async function listActivity(
  context: QueryContext,
  filters: ActivityFilters,
): Promise<ActivityPage> {
  const client = await queryClient(context);
  let query = client.from("audit_events").select("*").eq("org_id", context.orgId);
  if (filters.case_id) query = query.eq("case_id", filters.case_id);
  if (filters.actor) query = query.eq("actor_id", filters.actor);
  if (filters.outcome) query = query.eq("event_name", filters.outcome);
  if (filters.cursor) {
    const cursor = decodeCursor(filters.cursor);
    query = query.or(
      `occurred_at.lt.${cursor.at},and(occurred_at.eq.${cursor.at},id.lt.${cursor.id})`,
    );
  }
  const { data, error } = await query
    .order("occurred_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(filters.limit + 1);
  if (error) {
    throw new QueryError("query_failed", 503, "Activity is temporarily unavailable");
  }
  const rows = data ?? [];
  const hasMore = rows.length > filters.limit;
  const pageRows = rows.slice(0, filters.limit);
  const items = pageRows.map((row) => ({
    id: row.id,
    at: row.occurred_at,
    case_id: row.case_id,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    event_name: row.event_name,
    actor: { type: row.actor_type, id: row.actor_id },
    outcome: row.event_name,
    reason: row.reason,
    previous_version: row.previous_version,
    new_version: row.new_version,
  }));
  const last = pageRows.at(-1);
  return {
    items,
    next_cursor: hasMore && last
      ? Buffer.from(JSON.stringify({ at: last.occurred_at, id: last.id })).toString("base64url")
      : null,
  };
}
