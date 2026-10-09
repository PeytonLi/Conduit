import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { HARBOR_PACK_ORG_ID } from "./fixtures";
import { loadHarborPack } from "./harbor-pack";

function localSupabaseEnvironment(): {
  url: string;
  publishableKey: string;
  secretKey: string;
} {
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
  const result = await loadHarborPack({
    orgId: HARBOR_PACK_ORG_ID,
    fixtureId: "harbor-pack-canonical",
    reset: true,
    client,
  });
  console.log(`Harbor Pack Replay case ready: ${result.case_id}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Harbor Pack seed failed");
  process.exitCode = 1;
});
