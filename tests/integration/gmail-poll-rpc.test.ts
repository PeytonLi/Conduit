import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { supabaseRpcClient, type RpcClient } from "@/lib/db/messages";
import { createServiceClient } from "@/lib/db/service";
import {
  createInboxOrg,
  pgClient,
  type InboxOrg,
} from "./inbox-helpers";

vi.mock("server-only", () => ({}));

interface GmailConnection {
  org_id: string;
  connection_id: string;
  environment_mode: string;
}

interface GmailCredential {
  status: string;
  external_account_id: string | null;
  sync_cursor: string | null;
  encrypted_b64: string | null;
  key_version: string | null;
  expires_at: string | null;
}

let database: Client | null = null;
let fixture: InboxOrg | null = null;
let connectionId: string | null = null;
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
  connectionId = randomUUID();
  await db.query(
    "update public.organizations set environment_mode = 'replay' where id = $1",
    [fixture.orgId],
  );
  await db.query(
    `insert into public.connections
       (id, org_id, provider, external_account_id, status)
     values ($1, $2, 'gmail', 'gmail-poll-rpc-test', 'healthy')`,
    [connectionId, fixture.orgId],
  );
  await db.query(
    `insert into private.integration_credentials
       (org_id, connection_id, encrypted_credential_material, key_version)
     values ($1, $2, decode('010203', 'hex'), 'v1')`,
    [fixture.orgId, connectionId],
  );
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

describe("Gmail polling Supabase RPC wrapper", () => {
  it("lists replay Gmail connections and loads credentials through supabaseRpcClient", async () => {
    if (!rpc || !fixture || !connectionId) {
      throw new Error("Gmail RPC fixture was not initialized");
    }

    const connections = await rpc.rpc<GmailConnection[]>(
      "inbox_list_gmail_connections",
      {},
    );
    expect(connections).toContainEqual({
      org_id: fixture.orgId,
      connection_id: connectionId,
      environment_mode: "replay",
    });

    const credential = await rpc.rpc<GmailCredential>("gmail_load_credential", {
      org_id: fixture.orgId,
      connection_id: connectionId,
    });
    expect(credential).toMatchObject({
      status: "healthy",
      external_account_id: "gmail-poll-rpc-test",
      encrypted_b64: "AQID",
      key_version: "v1",
    });
  });
});
