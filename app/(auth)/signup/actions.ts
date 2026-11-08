"use server";

import { redirect } from "next/navigation";
import { joinInvitedOrganization, provisionPilotOrganization } from "@/lib/auth/provision-pilot-org";
import { isPilotSignupEnabled, parseInviteOrgId } from "@/lib/auth/pilot-signup";
import { createServiceClient } from "@/lib/db/service";
import { createServerClient } from "@/lib/db/server";

export async function signUp(formData: FormData) {
  if (!isPilotSignupEnabled()) {
    redirect("/signup?error=disabled");
  }

  const email = formData.get("email");
  const password = formData.get("password");
  const organizationName = formData.get("organization_name");
  const inviteOrg = formData.get("invite_org");
  if (typeof email !== "string" || typeof password !== "string") {
    redirect("/signup?error=invalid");
  }
  if (password.length < 12) {
    redirect("/signup?error=password");
  }

  const inviteOrgId =
    typeof inviteOrg === "string" ? parseInviteOrgId(inviteOrg) : null;
  if (typeof inviteOrg === "string" && inviteOrg.trim() && !inviteOrgId) {
    redirect("/signup?error=invite");
  }
  if (!inviteOrgId) {
    if (typeof organizationName !== "string" || !organizationName.trim()) {
      redirect("/signup?error=organization");
    }
  }

  const supabase = await createServerClient();
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error || !data.user) {
    redirect("/signup?error=credentials");
  }

  const service = createServiceClient();
  const { data: existingMembership } = await service
    .from("memberships")
    .select("org_id")
    .eq("auth_user_id", data.user.id)
    .eq("active", true)
    .maybeSingle();
  if (!existingMembership) {
    try {
      if (inviteOrgId) {
        await joinInvitedOrganization({ userId: data.user.id, orgId: inviteOrgId });
      } else {
        await provisionPilotOrganization({
          userId: data.user.id,
          organizationName: organizationName as string,
        });
      }
    } catch {
      redirect("/signup?error=provision");
    }
  }

  redirect("/onboarding");
}
