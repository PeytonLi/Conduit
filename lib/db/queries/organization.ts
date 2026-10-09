import { QueryError, type QueryContext, queryClient } from "./client";

export interface OrganizationSummary {
  id: string;
  name: string;
  timezone: string;
  currency: string;
  environment_mode: "live" | "sandbox" | "replay";
  current_policy_version_id: string | null;
  row_version: number;
}

export async function getOrganization(context: QueryContext): Promise<OrganizationSummary> {
  const client = await queryClient(context);
  const { data, error } = await client.from("organizations")
    .select("id,name,timezone,currency,environment_mode,current_policy_version_id,row_version")
    .eq("id", context.orgId)
    .maybeSingle();
  if (error) {
    throw new QueryError("query_failed", 503, "Organization details are temporarily unavailable");
  }
  if (!data) {
    throw new QueryError("organization_not_found", 404, "Organization not found");
  }
  return data;
}

export async function getSignedInEmail(context: QueryContext): Promise<string | null> {
  const client = await queryClient(context);
  const { data, error } = await client.auth.getUser();
  if (error) {
    throw new QueryError("query_failed", 503, "Account details are temporarily unavailable");
  }
  return data.user?.email ?? null;
}
