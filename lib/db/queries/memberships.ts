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

export interface AddMemberInput {
  email: string;
  role: MembershipView["role"];
  password?: string;
}

async function findUserIdByEmail(
  client: ReturnType<typeof createServiceClient>,
  email: string,
): Promise<string | null> {
  // ponytail: linear scan of auth users; fine for pilot-sized projects, switch to an RPC on auth.users past a few thousand.
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new QueryError("query_failed", 503, "Users are temporarily unavailable");
    const match = data.users.find((user) => user.email?.toLowerCase() === email);
    if (match) return match.id;
    if (data.users.length < 1000) return null;
  }
  return null;
}

/**
 * Adds a person to the caller's organization. A new email gets an account with the
 * owner-chosen temporary password; an existing account is attached as-is (password ignored).
 */
export async function addMember(
  context: QueryContext,
  input: AddMemberInput,
): Promise<{ membership_id: string; created_account: boolean }> {
  if (context.role !== "owner") {
    throw new QueryError("owner_required", 403, "An owner is required to add members");
  }
  const client = createServiceClient();
  const email = input.email.trim().toLowerCase();
  let userId = await findUserIdByEmail(client, email);
  const createdAccount = !userId;
  if (!userId) {
    if (!input.password || input.password.length < 12) {
      throw new QueryError("password_required", 422, "A temporary password of at least 12 characters is required for a new account");
    }
    const { data, error } = await client.auth.admin.createUser({
      email,
      password: input.password,
      email_confirm: true,
    });
    if (error || !data.user) {
      throw new QueryError("account_create_failed", 503, "Could not create the account");
    }
    userId = data.user.id;
  }
  const { data: existing, error: existingError } = await client.from("memberships")
    .select("org_id")
    .eq("auth_user_id", userId)
    .eq("active", true);
  if (existingError) throw new QueryError("query_failed", 503, "Memberships are temporarily unavailable");
  // The workspace resolves exactly one active organization per user.
  if (existing?.some((row) => row.org_id === context.orgId)) {
    throw new QueryError("already_member", 409, "This person is already a member");
  }
  if (existing?.length) {
    throw new QueryError("member_in_other_org", 409, "This person already belongs to another organization");
  }
  const { data: row, error } = await client.from("memberships")
    .upsert(
      { org_id: context.orgId, auth_user_id: userId, role: input.role, active: true },
      { onConflict: "org_id,auth_user_id" },
    )
    .select("id")
    .single();
  if (error || !row) throw new QueryError("query_failed", 503, "Could not add the member");
  return { membership_id: row.id, created_account: createdAccount };
}
