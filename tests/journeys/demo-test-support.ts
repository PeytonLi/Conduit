import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { HARBOR_PACK_ORG_ID, HARBOR_PACK_TIMES } from "../../lib/demo/fixtures";
import { loadHarborPack } from "../../lib/demo/harbor-pack";

function localSupabaseEnvironment(): { url: string; publishableKey: string; secretKey: string } {
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
  const publishableKey = values.ANON_KEY ?? values.SUPABASE_PUBLISHABLE_KEY;
  const secretKey = values.SERVICE_ROLE_KEY ?? values.SUPABASE_SECRET_KEY;
  if (!url || !publishableKey || !secretKey) {
    throw new Error("Local Supabase status did not provide its API and keys");
  }
  return { url, publishableKey, secretKey };
}

async function main(): Promise<void> {
  const local = localSupabaseEnvironment();
  process.env.SUPABASE_URL = local.url;
  process.env.SUPABASE_PUBLISHABLE_KEY = local.publishableKey;
  process.env.SUPABASE_SECRET_KEY = local.secretKey;
  process.env.APP_ENV ??= "replay";
  const client = createClient(local.url, local.secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  if (process.argv[2] === "seed-approval") {
    const planExpiresAt = new Date(Math.max(
      Date.parse(HARBOR_PACK_TIMES.quoteValidUntil),
      Date.now() + 20 * 60 * 1000,
    ));
    const result = await loadHarborPack({
      orgId: HARBOR_PACK_ORG_ID,
      fixtureId: "harbor-pack-canonical",
      reset: true,
      planExpiresAt,
      client,
    });
    process.stdout.write(JSON.stringify({ case_id: result.case_id }));
    return;
  }

  if (process.argv[2] === "cleanup-import") {
    const importId = process.argv[3];
    if (!importId) throw new Error("An import ID is required for cleanup");
    const { data: session, error: sessionReadError } = await client.from("import_sessions")
      .select("id,dataset_id,status")
      .eq("org_id", HARBOR_PACK_ORG_ID)
      .eq("id", importId)
      .maybeSingle();
    if (sessionReadError) throw sessionReadError;
    if (!session || session.status !== "active" || !session.dataset_id) {
      throw new Error("The activated import could not be found for cleanup");
    }
    const updatedAt = new Date().toISOString();
    const { error: datasetError } = await client.from("datasets")
      .update({ status: "superseded", updated_at: updatedAt })
      .eq("org_id", HARBOR_PACK_ORG_ID)
      .eq("id", session.dataset_id)
      .eq("status", "active");
    if (datasetError) throw datasetError;
    const { error: sessionError } = await client.from("import_sessions")
      .update({ status: "superseded", updated_at: updatedAt })
      .eq("org_id", HARBOR_PACK_ORG_ID)
      .eq("id", session.id)
      .eq("status", "active");
    if (sessionError) throw sessionError;
    return;
  }

  throw new Error("Expected seed-approval or cleanup-import");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Demo test support failed");
  process.exitCode = 1;
});
