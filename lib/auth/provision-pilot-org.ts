import "server-only";
import { createServiceRpc } from "@/lib/actions/rpc.supabase";
import { createServiceClient } from "@/lib/db/service";
import { parseServerEnv } from "@/lib/env";
import { defaultPolicySettings } from "@/lib/policies/schema";

export async function provisionPilotOrganization(input: {
  userId: string;
  organizationName: string;
  timezone?: string;
}): Promise<{ orgId: string }> {
  const client = createServiceClient();
  const env = parseServerEnv(process.env);
  const timezone = input.timezone ?? "America/Los_Angeles";
  const { data: org, error: orgError } = await client
    .from("organizations")
    .insert({
      name: input.organizationName.trim(),
      timezone,
      currency: "USD",
      environment_mode: env.APP_ENV,
    })
    .select("id")
    .single();
  if (orgError || !org) {
    throw new Error(orgError?.message ?? "Could not create organization");
  }

  const { error: membershipError } = await client.from("memberships").insert({
    org_id: org.id,
    auth_user_id: input.userId,
    role: "owner",
    active: true,
  });
  if (membershipError) {
    throw new Error(membershipError.message);
  }

  const { error: locationError } = await client.from("locations").insert({
    org_id: org.id,
    name: "Main warehouse",
    external_id: "MAIN-WAREHOUSE",
    timezone,
  });
  if (locationError) {
    throw new Error(locationError.message);
  }

  const rpc = createServiceRpc();
  const policyResult = (await rpc("policy_create_version", {
    p_org_id: org.id,
    p_actor_user_id: input.userId,
    p_expected_version: 0,
    p_settings: defaultPolicySettings,
    p_reason: "Initial pilot policy",
    p_now: new Date().toISOString(),
  })) as { ok?: boolean };
  if (!policyResult?.ok) {
    throw new Error("Could not create initial policy");
  }

  return { orgId: org.id };
}

export async function joinInvitedOrganization(input: {
  userId: string;
  orgId: string;
  role?: "operator" | "viewer";
}): Promise<{ orgId: string }> {
  const client = createServiceClient();
  const { data: org, error: orgError } = await client
    .from("organizations")
    .select("id")
    .eq("id", input.orgId)
    .maybeSingle();
  if (orgError || !org) {
    throw new Error("invite_org_not_found");
  }

  const { error: membershipError } = await client.from("memberships").insert({
    org_id: input.orgId,
    auth_user_id: input.userId,
    role: input.role ?? "operator",
    active: true,
  });
  if (membershipError) {
    throw new Error(membershipError.message);
  }

  return { orgId: input.orgId };
}
