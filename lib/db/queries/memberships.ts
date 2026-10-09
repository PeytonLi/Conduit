import { createServiceClient } from "@/lib/db/service";
import { QueryError, type QueryContext } from "./client";

export interface MembershipView {
  id: string;
  user_id: string;
  email: string | null;
  role: "owner" | "operator" | "viewer";
  active: boolean;
  row_version: number;
  is_self: boolean;
}

export async function listMemberships(context: QueryContext): Promise<MembershipView[]> {
  const client = createServiceClient();
  // Membership RLS is self-only; this server-only list is scoped to the authorized org.
  const { data, error } = await client.from("memberships")
    .select("id,auth_user_id,role,active,row_version")
    .eq("org_id", context.orgId)
    .order("created_at", { ascending: true });
  if (error) {
    throw new QueryError("query_failed", 503, "Memberships are temporarily unavailable");
  }
  const memberships = data ?? [];
  const users = await Promise.all(
    memberships.map(async (membership) => {
      const { data: result, error: userError } =
        await client.auth.admin.getUserById(membership.auth_user_id);
      if (userError) return [membership.auth_user_id, null] as const;
      return [membership.auth_user_id, result.user?.email ?? null] as const;
    }),
  );
  const emailByUser = new Map(users);
  return memberships.map((membership) => ({
    id: membership.id,
    user_id: membership.auth_user_id,
    email: emailByUser.get(membership.auth_user_id) ?? null,
    role: membership.role,
    active: membership.active,
    row_version: membership.row_version,
    is_self: membership.auth_user_id === context.userId,
  }));
}
