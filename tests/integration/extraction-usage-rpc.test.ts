import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { supabaseRpcClient, type RpcClient } from "@/lib/db/messages";
import { createServiceClient } from "@/lib/db/service";
import { createInboxOrg, pgClient, type InboxOrg } from "./inbox-helpers";

vi.mock("server-only", () => ({}));

let database: Client | null = null;
let fixture: InboxOrg | null = null;
let rpc: RpcClient | null = null;

function configureLocalSupabase(): void {
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
  process.env.SUPABASE_URL = values.API_URL ?? values.SUPABASE_URL;
  process.env.SUPABASE_PUBLISHABLE_KEY =
    values.ANON_KEY ?? values.SUPABASE_PUBLISHABLE_KEY;
  process.env.SUPABASE_SECRET_KEY =
    values.SERVICE_ROLE_KEY ?? values.SUPABASE_SECRET_KEY;
}

beforeAll(async () => {
  configureLocalSupabase();
  const db = pgClient();
  database = db;
  await db.connect();
  fixture = await createInboxOrg(db);
  rpc = supabaseRpcClient(createServiceClient());
});

afterAll(async () => {
  if (!database) return;
  try {
    if (fixture) {
      await database.query("set session_replication_role = replica");
      try {
        await database.query("delete from public.organizations where id = $1", [
          fixture.orgId,
        ]);
      } finally {
        await database.query("set session_replication_role = default");
      }
    }
  } finally {
    await database.end();
  }
});

describe("message extraction usage RPC", () => {
  it("writes DeepSeek usage through the RPC wrapper and ignores duplicates", async () => {
    if (!database || !fixture || !rpc) {
      throw new Error("Extraction usage fixture was not initialized");
    }
    const requestId = `extract-${randomUUID()}`;
    const input = {
      org_id: fixture.orgId,
      request_id: requestId,
      model: "deepseek-chat",
      raw_units: {
        prompt_tokens: 12,
        completion_tokens: 5,
        total_tokens: 17,
        prompt_cache_hit_tokens: 2,
        prompt_cache_miss_tokens: 10,
      },
    };

    await rpc.rpc("inbox_record_extraction_usage", input);
    await rpc.rpc("inbox_record_extraction_usage", {
      ...input,
      model: "different-model",
      raw_units: { prompt_tokens: 999 },
    });

    const result = await database.query(
      `select provider, request_id, charge_type, case_id, model, raw_units,
              estimated_cost, actual_cost, billing_currency, rate_version
       from public.usage_events
       where org_id = $1 and request_id = $2`,
      [fixture.orgId, requestId],
    );
    expect(result.rows).toEqual([
      {
        provider: "deepseek",
        request_id: requestId,
        charge_type: "message_extraction",
        case_id: null,
        model: "deepseek-chat",
        raw_units: input.raw_units,
        estimated_cost: null,
        actual_cost: null,
        billing_currency: null,
        rate_version: null,
      },
    ]);
  });
});
