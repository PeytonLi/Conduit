import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createInboxOrg, pgClient, pgRpcClient } from "./inbox-helpers";
import { ensureInboxConnection, ingestMessage } from "@/lib/db/messages";

const userA = randomUUID();
const userB = randomUUID();

const client = pgClient();
const rpc = () => pgRpcClient(client);

let ORG_A: string;
let ORG_B: string;

async function setRole(role: "authenticated" | "anon", userId?: string) {
  await client.query("begin");
  await client.query(`set local role ${role}`);
  if (userId) {
    await client.query(
      "select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)",
      [userId, JSON.stringify({ sub: userId, role })],
    );
  }
}

let extractionId: string;
let reviewId: string;
let messageId: string;

describe("inbox RLS", () => {
  beforeAll(async () => {
    await client.connect();
    // Leftover users from a previous aborted run would violate email uniqueness.
    await client.query(
      `delete from auth.users where email = any($1::text[])`,
      [["inbox-a@harbor.example", "inbox-b@other.example"]],
    );
    for (const [id, email] of [
      [userA, "inbox-a@harbor.example"],
      [userB, "inbox-b@other.example"],
    ]) {
      await client.query(
        `insert into auth.users
          (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
           confirmation_token,
           raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
         values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated',
           'authenticated', $2, '', now(), '', '{"provider":"email","providers":["email"]}',
           '{}', now(), now())
         on conflict (id) do nothing`,
        [id, email],
      );
      await client.query(
        `update auth.users set recovery_token = '', email_change_token_new = '',
          email_change = '', phone_change = '', phone_change_token = '',
          email_change_token_current = '', reauthentication_token = '' where id = $1`,
        [id],
      );
    }
    const orgA = await createInboxOrg(client);
    const orgB = await createInboxOrg(client);
    ORG_A = orgA.orgId;
    ORG_B = orgB.orgId;
    await client.query(
      `insert into public.memberships (org_id, auth_user_id, role)
       values ($1, $3, 'owner'), ($2, $4, 'owner')
       on conflict (org_id, auth_user_id) do nothing`,
      [ORG_A, ORG_B, userA, userB],
    );

    const connId = await ensureInboxConnection(rpc(), ORG_A, "replay_inbox");
    const stored = await ingestMessage({
      rpc: rpc(),
      orgId: ORG_A,
      connectionId: connId,
      providerMessageId: "rls-msg-1",
      raw: "From: a@b.example\n\nbody text",
      historical: true,
      direction: "inbound",
    });
    messageId = stored.source_message_id;
    const ext = await rpc().rpc<{ id: string }>("inbox_record_extraction", {
      org_id: ORG_A,
      source_message_id: messageId,
      extractor: "replay_fixture",
      status: "valid",
      facts: { schema_version: 1, is_delay_notice: false, lines: [], notes_for_reviewer: "" },
      unresolved: [],
    });
    extractionId = ext.id;
    await rpc().rpc("inbox_dismiss_message", {
      org_id: ORG_A,
      source_message_id: messageId,
      actor_user_id: null,
      reason: "test",
    });
    const rev = await client.query(
      `insert into public.message_match_reviews (org_id, source_message_id, status)
       values ($1, $2, 'open') returning id`,
      [ORG_A, messageId],
    );
    reviewId = rev.rows[0].id;
  });

  afterAll(async () => {
    await client.query("set session_replication_role = replica");
    await client.query(
      `delete from public.message_match_reviews where org_id = $1`,
      [ORG_A],
    );
    await client.query(`delete from public.message_extractions where org_id = $1`, [
      ORG_A,
    ]);
    await client.query(`delete from private.source_message_content where org_id = $1`, [
      ORG_A,
    ]);
    await client.query(
      `delete from public.evidence where org_id = $1 and source_type = 'email'`,
      [ORG_A],
    );
    await client.query(`delete from public.source_messages where org_id = $1`, [
      ORG_A,
    ]);
    await client.query(
      `delete from public.connections where org_id = $1 and provider = 'replay_inbox'`,
      [ORG_A],
    );
    // Deleting the fresh orgs cascades memberships and all inbox rows.
    await client.query(
      `delete from public.organizations where id = any($1::uuid[])`,
      [[ORG_A, ORG_B]],
    );
    await client.query(`delete from auth.users where id = any($1::uuid[])`, [
      [userA, userB],
    ]);
    await client.query("set session_replication_role = default");
    await client.end();
  });

  it("an org B member cannot read org A message_extractions", async () => {
    await setRole("authenticated", userB);
    const res = await client.query(
      `select id from public.message_extractions where id = $1`,
      [extractionId],
    );
    await client.query("rollback");
    expect(res.rows).toHaveLength(0);
  });

  it("an org A member CAN read its own message_extractions", async () => {
    await setRole("authenticated", userA);
    const res = await client.query(
      `select id from public.message_extractions where id = $1`,
      [extractionId],
    );
    await client.query("rollback");
    expect(res.rows).toHaveLength(1);
  });

  it("an org B member cannot read org A message_match_reviews", async () => {
    await setRole("authenticated", userB);
    const res = await client.query(
      `select id from public.message_match_reviews where id = $1`,
      [reviewId],
    );
    await client.query("rollback");
    expect(res.rows).toHaveLength(0);
  });

  it("authenticated cannot execute the new rpc functions", async () => {
    await setRole("authenticated", userA);
    for (const fn of [
      "inbox_store_message",
      "inbox_load_message",
      "inbox_match_context",
      "inbox_record_extraction",
      "inbox_open_cases",
      "inbox_dismiss_message",
      "gmail_store_connection",
      "gmail_load_credential",
      "gmail_set_status",
      "gmail_advance_cursor",
      "inbox_list_gmail_connections",
      "inbox_ensure_connection",
      "inbox_case_review_lookup",
      "inbox_request_key_store",
      "inbox_request_key_complete",
    ]) {
      await expect(
        client.query(`select public.${fn}('{}'::jsonb)`),
      ).rejects.toThrow();
      await client.query("rollback");
      await setRole("authenticated", userA);
    }
    await client.query("rollback").catch(() => {});
  });

  it("private.source_message_content is not readable by authenticated", async () => {
    await setRole("authenticated", userA);
    await expect(
      client.query(`select * from private.source_message_content`),
    ).rejects.toThrow();
    await client.query("rollback");
  });
});
