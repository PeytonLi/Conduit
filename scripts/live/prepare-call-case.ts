import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { policySettingsSchema } from "../../lib/policies/schema";

const harborOrgId = "00000000-0000-4000-8000-000000000001";
const supplierName = "Conduit Voice Test (authorized)";
const shortageAt = "2026-10-14T16:00:00.000Z";

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function localSupabaseEnvironment(): { url: string; serviceKey: string } {
  const output = execFileSync("pnpm", ["exec", "supabase", "status", "-o", "env"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const values = Object.fromEntries(
    output
      .split(/\r?\n/)
      .map((line) => line.match(/^([A-Z_]+)="?(.*?)"?$/))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .map((match) => [match[1], match[2]]),
  );
  const url = values.API_URL ?? values.SUPABASE_URL;
  const serviceKey = values.SERVICE_ROLE_KEY ?? values.SUPABASE_SECRET_KEY;
  if (!url || !serviceKey) throw new Error("local_supabase_unavailable");
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname)) {
    throw new Error("local_supabase_required");
  }
  return { url, serviceKey };
}

async function main() {
  process.loadEnvFile(".env.local");
  const phone = process.env.VOICE_TEST_PHONE_NUMBER?.trim();
  if (!phone) throw new Error("voice_test_number_missing");

  const local = localSupabaseEnvironment();
  const supabase = createClient(local.url, local.serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: organization, error: organizationError } = await supabase
    .from("organizations")
    .select("id")
    .eq("id", harborOrgId)
    .maybeSingle();
  if (organizationError || !organization) throw new Error("harbor_org_missing");

  const { data: users, error: usersError } = await supabase.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });
  if (usersError) throw new Error("owner_user_lookup_failed");
  let owner = users.users.find((user) => user.email === "owner@harbor.example");
  if (!owner) {
    execFileSync("pnpm", ["seed:demo"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const { data: seededUsers, error: seededUsersError } = await supabase.auth.admin.listUsers({
      page: 1,
      perPage: 1000,
    });
    if (seededUsersError) throw new Error("owner_user_lookup_failed");
    owner = seededUsers.users.find((user) => user.email === "owner@harbor.example");
  }
  if (!owner) throw new Error("owner_user_missing");

  const now = new Date().toISOString();
  const { error: organizationUpdateError } = await supabase
    .from("organizations")
    .update({ environment_mode: "sandbox", updated_at: now })
    .eq("id", harborOrgId);
  if (organizationUpdateError) throw new Error("organization_update_failed");

  const { data: membership, error: membershipError } = await supabase
    .from("memberships")
    .select("role,active")
    .eq("org_id", harborOrgId)
    .eq("auth_user_id", owner.id)
    .maybeSingle();
  if (membershipError || membership?.role !== "owner" || !membership.active) {
    throw new Error("owner_membership_missing");
  }

  const { data: currentPolicies, error: policiesError } = await supabase
    .from("policies")
    .select("version,settings")
    .eq("org_id", harborOrgId)
    .order("version", { ascending: false })
    .limit(1);
  if (policiesError) throw new Error("policy_lookup_failed");
  const currentPolicy = currentPolicies?.[0];
  const currentSettings = objectOrEmpty(currentPolicy?.settings);
  const settings = policySettingsSchema.parse({
    ...currentSettings,
    outreach: {
      ...objectOrEmpty(currentSettings.outreach),
      call_enabled: true,
      contact_hours: { weekdays: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" },
    },
    negotiation: {
      ...objectOrEmpty(currentSettings.negotiation),
      ceiling_minor: "10000",
    },
  });
  const { data: policyResult, error: policyError } = await supabase.rpc(
    "policy_create_version",
    {
      p_org_id: harborOrgId,
      p_actor_user_id: owner.id,
      p_expected_version: currentPolicy?.version ?? 0,
      p_settings: settings,
      p_reason: "Authorize the sandbox voice-test harness",
      p_now: now,
    },
  );
  if (policyError) throw new Error("policy_creation_failed");
  const policy = policyResult as { ok?: boolean; policy_version_id?: string } | null;
  if (!policy?.ok || !policy.policy_version_id) throw new Error("policy_creation_failed");

  const { data: supplierRow, error: supplierLookupError } = await supabase
    .from("suppliers")
    .select("id")
    .eq("org_id", harborOrgId)
    .eq("name", supplierName)
    .maybeSingle();
  if (supplierLookupError) throw new Error("supplier_lookup_failed");
  let supplierId = supplierRow?.id;
  if (supplierId) {
    const { error } = await supabase
      .from("suppliers")
      .update({
        purchasing_status: "approved",
        approval_actor: owner.id,
        approval_at: now,
        updated_at: now,
      })
      .eq("id", supplierId)
      .eq("org_id", harborOrgId);
    if (error) throw new Error("supplier_update_failed");
  } else {
    const { data, error } = await supabase
      .from("suppliers")
      .insert({
        org_id: harborOrgId,
        name: supplierName,
        purchasing_status: "approved",
        approval_actor: owner.id,
        approval_at: now,
      })
      .select("id")
      .single();
    if (error || !data) throw new Error("supplier_creation_failed");
    supplierId = data.id;
  }

  const { data: existingContact, error: contactLookupError } = await supabase
    .from("supplier_contacts")
    .select("id")
    .eq("org_id", harborOrgId)
    .eq("channel", "phone")
    .eq("normalized_address", phone)
    .maybeSingle();
  if (contactLookupError) throw new Error("contact_lookup_failed");
  const contactValues = {
    org_id: harborOrgId,
    supplier_id: supplierId,
    channel: "phone",
    normalized_address: phone,
    display_name: supplierName,
    timezone: "America/Los_Angeles",
    permitted_channels: ["phone"],
    outreach_approved_at: now,
    outreach_approved_by: owner.id,
  };
  let contactId = existingContact?.id;
  if (contactId) {
    const { error } = await supabase
      .from("supplier_contacts")
      .update({ ...contactValues, updated_at: now })
      .eq("id", contactId)
      .eq("org_id", harborOrgId);
    if (error) throw new Error("contact_update_failed");
  } else {
    const { data, error } = await supabase
      .from("supplier_contacts")
      .insert(contactValues)
      .select("id")
      .single();
    if (error || !data) throw new Error("contact_creation_failed");
    contactId = data.id;
  }

  const { data: item, error: itemError } = await supabase
    .from("items")
    .select("id")
    .eq("org_id", harborOrgId)
    .eq("sku", "CARTON-302015")
    .maybeSingle();
  if (itemError || !item) throw new Error("harbor_item_missing");
  const { data: location, error: locationError } = await supabase
    .from("locations")
    .select("id")
    .eq("org_id", harborOrgId)
    .eq("name", "Main Warehouse")
    .maybeSingle();
  if (locationError || !location) throw new Error("main_warehouse_missing");

  const { data: existingCase, error: caseLookupError } = await supabase
    .from("cases")
    .select("id,run_control")
    .eq("org_id", harborOrgId)
    .eq("item_id", item.id)
    .eq("location_id", location.id)
    .neq("phase", "closed")
    .limit(1)
    .maybeSingle();
  if (caseLookupError) throw new Error("case_lookup_failed");
  let caseId = existingCase?.id;
  if (caseId) {
    const { error } = await supabase
      .from("cases")
      .update({ run_control: "active", updated_at: now })
      .eq("id", caseId)
      .eq("org_id", harborOrgId);
    if (error) throw new Error("case_activation_failed");
  } else {
    const { data, error } = await supabase
      .from("cases")
      .insert({
        org_id: harborOrgId,
        item_id: item.id,
        location_id: location.id,
        run_control: "active",
        severity: "warning",
      })
      .select("id")
      .single();
    if (error || !data) throw new Error("case_creation_failed");
    caseId = data.id;
  }

  const { data: previousAssessment, error: assessmentLookupError } = await supabase
    .from("assessments")
    .select("version")
    .eq("org_id", harborOrgId)
    .eq("case_id", caseId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (assessmentLookupError) throw new Error("assessment_lookup_failed");
  const assessmentVersion = (previousAssessment?.version ?? 0) + 1;
  const { data: assessment, error: assessmentError } = await supabase
    .from("assessments")
    .insert({
      org_id: harborOrgId,
      case_id: caseId,
      version: assessmentVersion,
      input_fingerprint: `live-voice-prep:${caseId}:${assessmentVersion}`,
      policy_version_id: policy.policy_version_id,
      source_versions: { live_voice_prep: 1 },
      horizon_start: now,
      horizon_end: shortageAt,
      quality: "sufficient",
      first_shortage_at: shortageAt,
      bridge_qty: 600,
      projection: {
        quality: "sufficient",
        firstShortageAt: shortageAt,
        bridgeQuantity: 600,
      },
      dated_requirements: [{ by: shortageAt, cumulativeQuantity: 600 }],
    })
    .select("id")
    .single();
  if (assessmentError || !assessment) throw new Error("assessment_creation_failed");
  const { error: currentAssessmentError } = await supabase
    .from("cases")
    .update({ current_assessment_id: assessment.id, updated_at: now })
    .eq("id", caseId)
    .eq("org_id", harborOrgId);
  if (currentAssessmentError) throw new Error("assessment_activation_failed");

  console.log(`org_id=${harborOrgId}`);
  console.log(`case_id=${caseId}`);
  console.log(`contact_id=${contactId}`);
  console.log(`policy_id=${policy.policy_version_id}`);
}

main().catch(() => {
  console.error("Live call preparation failed; sensitive details suppressed.");
  process.exitCode = 1;
});
