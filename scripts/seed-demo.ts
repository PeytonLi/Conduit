import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const localOnlyPassword = "HarborPackLocalOnly!2026";
const harborOrgId = "00000000-0000-4000-8000-000000000001";
const otherOrgId = "00000000-0000-4000-8000-000000000002";

function localSupabaseEnvironment(): { url: string; anonKey: string; serviceKey: string } {
  const output = execFileSync("pnpm", ["exec", "supabase", "status", "-o", "env"], {
    encoding: "utf8",
  });
  const values = Object.fromEntries(
    output
      .split(/\r?\n/)
      .map((line) => line.match(/^([A-Z_]+)="?(.*?)"?$/))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .map((match) => [match[1], match[2]]),
  );
  const url = values.API_URL ?? values.SUPABASE_URL;
  const anonKey = values.ANON_KEY ?? values.SUPABASE_PUBLISHABLE_KEY;
  const serviceKey = values.SERVICE_ROLE_KEY ?? values.SUPABASE_SECRET_KEY;
  if (!url || !anonKey || !serviceKey) {
    throw new Error("Local Supabase status did not provide its API and keys");
  }
  return { url, anonKey, serviceKey };
}

async function main() {
  const local = localSupabaseEnvironment();
  process.env.SUPABASE_URL = local.url;
  process.env.SUPABASE_PUBLISHABLE_KEY = local.anonKey;
  process.env.SUPABASE_SECRET_KEY = local.serviceKey;
  const supabase = createClient(local.url, local.serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const accounts = [
    { email: "owner@harbor.example", orgId: harborOrgId, role: "owner" },
    { email: "operator@harbor.example", orgId: harborOrgId, role: "operator" },
    { email: "viewer@harbor.example", orgId: harborOrgId, role: "viewer" },
    { email: "other-owner@other.example", orgId: otherOrgId, role: "owner" },
  ] as const;

  async function findUserByEmail(email: string) {
    const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (error) {
      throw new Error(`Could not list local Auth users: ${error.message}`);
    }
    return data.users.find((user) => user.email === email) ?? null;
  }

  for (const account of accounts) {
    let user = await findUserByEmail(account.email);
    if (!user) {
      const { data, error } = await supabase.auth.admin.createUser({
        email: account.email,
        password: localOnlyPassword,
        email_confirm: true,
      });
      if (error || !data.user) {
        throw new Error(`Could not provision ${account.email}: ${error?.message ?? "no user"}`);
      }
      user = data.user;
    } else {
      const { error } = await supabase.auth.admin.updateUserById(user.id, {
        password: localOnlyPassword,
        email_confirm: true,
      });
      if (error) {
        throw new Error(`Could not update ${account.email}: ${error.message}`);
      }
    }

    const { error } = await supabase
      .from("memberships")
      .upsert(
        {
          org_id: account.orgId,
          auth_user_id: user.id,
          role: account.role,
          active: true,
        },
        { onConflict: "org_id,auth_user_id" },
      );
    if (error) {
      throw new Error(`Could not assign ${account.email}: ${error.message}`);
    }
  }
  console.log("Demo accounts are ready. Use the local-only password documented in README.md.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Demo seed failed");
  process.exitCode = 1;
});
