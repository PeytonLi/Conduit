import { QueryError, type QueryContext, queryClient } from "./client";

export interface PolicyView {
  id: string;
  version: number;
  effective_from: string;
  settings: Record<string, unknown>;
  reason: string;
  author_user_id: string | null;
}

export async function getCurrentPolicy(context: QueryContext): Promise<PolicyView | null> {
  const client = await queryClient(context);
  const { data: organization, error: organizationError } = await client.from("organizations")
    .select("current_policy_version_id")
    .eq("id", context.orgId)
    .maybeSingle();
  if (organizationError) {
    throw new QueryError("query_failed", 503, "Policy details are temporarily unavailable");
  }
  if (!organization?.current_policy_version_id) return null;

  const { data, error } = await client.from("policies")
    .select("id,version,effective_at,settings,reason,author_user_id")
    .eq("org_id", context.orgId)
    .eq("id", organization.current_policy_version_id)
    .maybeSingle();
  if (error) {
    throw new QueryError("query_failed", 503, "Policy details are temporarily unavailable");
  }
  if (!data) return null;
  return {
    id: data.id,
    version: data.version,
    effective_from: data.effective_at,
    settings: data.settings,
    reason: data.reason,
    author_user_id: data.author_user_id,
  };
}
