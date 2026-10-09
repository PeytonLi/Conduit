import type { User } from "@supabase/supabase-js";
import { membershipRoleSchema, type MembershipRole } from "@/lib/schemas/enums";
import { createServerClient } from "@/lib/db/server";

export class AuthenticationError extends Error {
  readonly status = 401;

  constructor() {
    super("Authentication required");
    this.name = "AuthenticationError";
  }
}

export class AuthorizationError extends Error {
  readonly status = 403;

  constructor(message = "Membership required") {
    super(message);
    this.name = "AuthorizationError";
  }
}

export interface MembershipContext {
  userId: string;
  orgId: string;
  role: MembershipRole;
}

export async function requireMembership(
  roles?: readonly MembershipRole[],
): Promise<MembershipContext> {
  const supabase = await createServerClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    throw new AuthenticationError();
  }

  return membershipForUser(supabase, user, roles);
}

async function membershipForUser(
  supabase: Awaited<ReturnType<typeof createServerClient>>,
  user: User,
  roles?: readonly MembershipRole[],
): Promise<MembershipContext> {
  const { data: memberships, error } = await supabase
    .from("memberships")
    .select("org_id, role")
    .eq("auth_user_id", user.id)
    .eq("active", true)
    .order("created_at", { ascending: true })
    .limit(2);

  if (error || !memberships?.length) {
    throw new AuthorizationError();
  }

  if (memberships.length !== 1) {
    throw new AuthorizationError("Select a single active organization");
  }

  const membership = memberships[0];
  const role = membershipRoleSchema.parse(membership.role);
  if (roles && !roles.includes(role)) {
    throw new AuthorizationError("Insufficient membership role");
  }

  return { userId: user.id, orgId: membership.org_id, role };
}
