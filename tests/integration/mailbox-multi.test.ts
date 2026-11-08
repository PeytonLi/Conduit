import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { requestOutreach } from "@/lib/actions/outreach";
import {
  connect,
  deps,
  FakeClock,
  seedHarbor,
  type Harbor,
} from "./actions.harness";

const client = connect();
let harbor: Harbor;

type Json = Record<string, unknown>;

async function call<T = Json>(fn: string, args: Json): Promise<T> {
  const { rows } = await client.query(`select public.${fn}($1::jsonb) as r`, [
    JSON.stringify(args),
  ]);
  return rows[0].r as T;
}

async function storeMailbox(
  orgId: string,
  provider: "gmail" | "outlook",
  account: string,
): Promise<{ connection_id: string; is_primary: boolean }> {
  return call("mailbox_store_connection", {
    org_id: orgId,
    actor_user_id: harbor.ownerId,
    provider,
    external_account_id: account,
    scopes: ["mail.read"],
    capabilities: { mail_read: true, mail_send: true },
    encrypted_b64: Buffer.from(`secret-${account}`).toString("base64"),
    key_version: "v1",
  });
}

let savepoints = 0;

/** A failing statement aborts the surrounding transaction; run it under a savepoint. */
async function failsWith(run: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  const name = `sp_${savepoints++}`;
  await client.query(`savepoint ${name}`);
  await expect(run()).rejects.toThrow(pattern);
  await client.query(`rollback to savepoint ${name}`);
}

async function primaryOf(orgId: string): Promise<string | null> {
  const { rows } = await client.query(
    "select id from public.connections where org_id = $1 and is_primary",
    [orgId],
  );
  return rows[0]?.id ?? null;
}

async function prepareEmail(h: Harbor): Promise<string> {
  const result = await requestOutreach(deps(client, new FakeClock()), {
    orgId: h.orgId,
    caseId: h.caseId,
    userId: h.operatorId,
    idempotencyKey: randomUUID(),
    body: {
      contact_id: h.contactId,
      channel: "email",
      message: { subject: "Mailbox routing", body: "Please confirm delivery." },
    },
  });
  if (!result.ok || result.result !== "prepared_action") throw new Error("not prepared");
  return result.action.id;
}

async function claim(h: Harbor, actionId: string): Promise<Json> {
  const { rows } = await client.query(
    "select public.ledger_claim_dispatch($1, $2, 300, $3::timestamptz) as result",
    [h.orgId, actionId, "2026-10-12T15:00:00.000Z"],
  );
  return rows[0].result as Json;
}

describe("multi-mailbox connections", () => {
  beforeAll(async () => {
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
  });
  beforeEach(async () => {
    await client.query("begin");
    harbor = await seedHarbor(client, { mode: "sandbox" });
    // The seeded Gmail row is not a stored mailbox; start from a clean org.
    await client.query("delete from public.connections where org_id = $1", [harbor.orgId]);
  });
  afterEach(async () => {
    await client.query("rollback");
  });

  it("lets an organization hold several mailboxes and makes the first one primary", async () => {
    const gmail = await storeMailbox(harbor.orgId, "gmail", "ops@harbor.example");
    const outlook = await storeMailbox(harbor.orgId, "outlook", "buyer@harbor.example");
    const second = await storeMailbox(harbor.orgId, "outlook", "backup@harbor.example");

    expect(new Set([gmail.connection_id, outlook.connection_id, second.connection_id]).size).toBe(3);
    expect(gmail.is_primary).toBe(true);
    expect(outlook.is_primary).toBe(false);
    expect(second.is_primary).toBe(false);
    expect(await primaryOf(harbor.orgId)).toBe(gmail.connection_id);

    // Reconnecting the same account updates it in place and keeps the primary.
    const again = await storeMailbox(harbor.orgId, "outlook", "buyer@harbor.example");
    expect(again.connection_id).toBe(outlook.connection_id);
    expect(await primaryOf(harbor.orgId)).toBe(gmail.connection_id);
  });

  it("rejects a provider that is not a mailbox", async () => {
    await failsWith(
      () =>
        call("mailbox_store_connection", {
          org_id: harbor.orgId,
          provider: "quickbooks",
          external_account_id: "x",
          encrypted_b64: "AQID",
          key_version: "v1",
        }),
      /unknown mailbox provider/,
    );
  });

  it("allows only one primary mailbox per organization", async () => {
    const gmail = await storeMailbox(harbor.orgId, "gmail", "ops@harbor.example");
    const outlook = await storeMailbox(harbor.orgId, "outlook", "buyer@harbor.example");
    await failsWith(
      () =>
        client.query("update public.connections set is_primary = true where id = $1", [
          outlook.connection_id,
        ]),
      /connections_one_primary_mailbox/,
    );
    await failsWith(
      () =>
        client.query(
          "insert into public.connections (org_id, provider, external_account_id, is_primary) values ($1, 'quickbooks', 'q', true)",
          [harbor.orgId],
        ),
      /connections_primary_is_mailbox/,
    );
    expect(await primaryOf(harbor.orgId)).toBe(gmail.connection_id);
  });

  it("switches the primary mailbox and records an audit event", async () => {
    const gmail = await storeMailbox(harbor.orgId, "gmail", "ops@harbor.example");
    const outlook = await storeMailbox(harbor.orgId, "outlook", "buyer@harbor.example");

    const changed = await call("mailbox_set_primary", {
      org_id: harbor.orgId,
      actor_user_id: harbor.ownerId,
      connection_id: outlook.connection_id,
    });
    expect(changed).toMatchObject({ ok: true, changed: true });
    expect(await primaryOf(harbor.orgId)).toBe(outlook.connection_id);

    const noop = await call("mailbox_set_primary", {
      org_id: harbor.orgId,
      actor_user_id: harbor.ownerId,
      connection_id: outlook.connection_id,
    });
    expect(noop).toMatchObject({ ok: true, changed: false });

    const audit = await client.query(
      `select count(*)::int as n from public.audit_events
       where org_id = $1 and event_name = 'connection.mailbox.primary_changed'`,
      [harbor.orgId],
    );
    expect(audit.rows[0].n).toBe(1);

    await client.query("update public.connections set status = 'revoked' where id = $1", [
      gmail.connection_id,
    ]);
    await expect(
      call("mailbox_set_primary", {
        org_id: harbor.orgId,
        actor_user_id: harbor.ownerId,
        connection_id: gmail.connection_id,
      }),
    ).resolves.toMatchObject({ ok: false, code: "not_connected" });
  });

  it("lists active mailboxes per provider for the pollers", async () => {
    const gmail = await storeMailbox(harbor.orgId, "gmail", "ops@harbor.example");
    const outlook = await storeMailbox(harbor.orgId, "outlook", "buyer@harbor.example");
    const dead = await storeMailbox(harbor.orgId, "outlook", "old@harbor.example");
    await client.query("update public.connections set status = 'revoked' where id = $1", [
      dead.connection_id,
    ]);

    const outlookOnly = await call<{ org_id: string; connection_id: string; provider: string }[]>(
      "inbox_list_mailbox_connections",
      { provider: "outlook" },
    );
    const mine = outlookOnly.filter((c) => c.org_id === harbor.orgId);
    expect(mine.map((c) => c.connection_id)).toEqual([outlook.connection_id]);

    const all = await call<{ connection_id: string }[]>("inbox_list_mailbox_connections", {});
    const ids = all.map((c) => c.connection_id);
    expect(ids).toContain(gmail.connection_id);
    expect(ids).toContain(outlook.connection_id);
    expect(ids).not.toContain(dead.connection_id);
  });

  it("never reads or changes a mailbox through another organization", async () => {
    const outlook = await storeMailbox(harbor.orgId, "outlook", "buyer@harbor.example");
    const otherOrg = randomUUID();
    const args = { org_id: otherOrg, connection_id: outlook.connection_id };

    await failsWith(() => call("mailbox_load_credential", args), /not found/);
    await expect(call("mailbox_set_status", { ...args, status: "revoked" })).resolves.toMatchObject({
      updated: false,
    });
    await expect(
      call("mailbox_advance_cursor", { ...args, expected_cursor: null, new_cursor: "x" }),
    ).resolves.toMatchObject({ advanced: false });
    await expect(
      call("mailbox_update_credential", { ...args, encrypted_b64: "AQID", key_version: "v1" }),
    ).resolves.toMatchObject({ updated: false });
    await expect(
      call("mailbox_set_primary", { ...args, actor_user_id: harbor.ownerId }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      call("ui_disconnect_connection", { ...args, actor_user_id: harbor.ownerId }),
    ).resolves.toMatchObject({ disconnected: false });

    const row = await client.query(
      "select status, sync_cursor from public.connections where id = $1",
      [outlook.connection_id],
    );
    expect(row.rows[0]).toEqual({ status: "healthy", sync_cursor: null });
  });

  it("advances the cursor with compare-and-swap and persists a rotated credential", async () => {
    const outlook = await storeMailbox(harbor.orgId, "outlook", "buyer@harbor.example");
    const base = { org_id: harbor.orgId, connection_id: outlook.connection_id };

    await expect(
      call("mailbox_advance_cursor", { ...base, expected_cursor: null, new_cursor: "delta-1" }),
    ).resolves.toMatchObject({ advanced: true });
    await expect(
      call("mailbox_advance_cursor", { ...base, expected_cursor: null, new_cursor: "delta-2" }),
    ).resolves.toMatchObject({ advanced: false });

    const rotated = Buffer.from("rotated-refresh-token").toString("base64");
    await expect(
      call("mailbox_update_credential", { ...base, encrypted_b64: rotated, key_version: "v1" }),
    ).resolves.toMatchObject({ updated: true });
    const loaded = await call<Json>("mailbox_load_credential", base);
    expect(loaded).toMatchObject({
      provider: "outlook",
      status: "healthy",
      sync_cursor: "delta-1",
      external_account_id: "buyer@harbor.example",
      encrypted_b64: rotated,
    });
  });

  it("disconnects one mailbox by id, hands the primary on, and removes only its credential", async () => {
    const gmail = await storeMailbox(harbor.orgId, "gmail", "ops@harbor.example");
    const outlook = await storeMailbox(harbor.orgId, "outlook", "buyer@harbor.example");
    expect(await primaryOf(harbor.orgId)).toBe(gmail.connection_id);

    const result = await call("ui_disconnect_connection", {
      org_id: harbor.orgId,
      actor_user_id: harbor.ownerId,
      connection_id: gmail.connection_id,
    });
    expect(result).toMatchObject({ disconnected: true, provider: "gmail" });
    expect(await primaryOf(harbor.orgId)).toBe(outlook.connection_id);

    const credentials = await client.query(
      "select connection_id from private.integration_credentials where org_id = $1",
      [harbor.orgId],
    );
    expect(credentials.rows.map((r) => r.connection_id)).toEqual([outlook.connection_id]);

    const audit = await client.query(
      `select count(*)::int as n from public.audit_events
       where org_id = $1 and entity_id = $2 and event_name = 'connection.gmail.disconnected'`,
      [harbor.orgId, gmail.connection_id],
    );
    expect(audit.rows[0].n).toBe(1);
  });

  it("can remove a mailbox that already expired", async () => {
    const outlook = await storeMailbox(harbor.orgId, "outlook", "buyer@harbor.example");
    await client.query("update public.connections set status = 'expired' where id = $1", [
      outlook.connection_id,
    ]);
    await expect(
      call("ui_disconnect_connection", {
        org_id: harbor.orgId,
        actor_user_id: harbor.ownerId,
        connection_id: outlook.connection_id,
      }),
    ).resolves.toMatchObject({ disconnected: true, provider: "outlook" });
  });

  it("without a connection id disconnects the latest active Gmail, as before", async () => {
    const gmail = await storeMailbox(harbor.orgId, "gmail", "ops@harbor.example");
    await storeMailbox(harbor.orgId, "outlook", "buyer@harbor.example");
    await expect(
      call("ui_disconnect_connection", { org_id: harbor.orgId, actor_user_id: harbor.ownerId }),
    ).resolves.toMatchObject({ disconnected: true, connection_id: gmail.connection_id });
  });

  it("claims an email only when the mailbox the action names is active", async () => {
    const gmail = await storeMailbox(harbor.orgId, "gmail", "ops@harbor.example");
    const outlook = await storeMailbox(harbor.orgId, "outlook", "buyer@harbor.example");
    const actionId = await prepareEmail(harbor);

    // The named Outlook mailbox is revoked while Gmail stays healthy: no fallback.
    await client.query(
      "update public.actions set payload = payload || $2::jsonb where id = $1",
      [actionId, JSON.stringify({ connection_id: outlook.connection_id })],
    );
    await client.query("update public.connections set status = 'revoked' where id = $1", [
      outlook.connection_id,
    ]);
    await expect(claim(harbor, actionId)).resolves.toMatchObject({
      ok: false,
      code: "failed_precondition",
      reason: "connection_unavailable",
    });

    // The same action naming the healthy Gmail mailbox claims fine.
    await client.query(
      "update public.actions set payload = payload || $2::jsonb where id = $1",
      [actionId, JSON.stringify({ connection_id: gmail.connection_id })],
    );
    await expect(claim(harbor, actionId)).resolves.toMatchObject({ ok: true });
  });

  it("does not let an action borrow a mailbox of another organization", async () => {
    await storeMailbox(harbor.orgId, "gmail", "ops@harbor.example");
    const other = await seedHarbor(client, { mode: "sandbox" });
    await client.query("delete from public.connections where org_id = $1", [other.orgId]);
    const foreign = await storeMailbox(other.orgId, "outlook", "other@elsewhere.example");

    const actionId = await prepareEmail(harbor);
    await client.query(
      "update public.actions set payload = payload || $2::jsonb where id = $1",
      [actionId, JSON.stringify({ connection_id: foreign.connection_id })],
    );
    await expect(claim(harbor, actionId)).resolves.toMatchObject({
      ok: false,
      reason: "connection_unavailable",
    });
  });

  describe("the same email reaching two mailboxes", () => {
    function message(connectionId: string, providerMessageId: string, rfc = "<dup-1@supplier.example>") {
      return {
        org_id: harbor.orgId,
        connection_id: connectionId,
        provider_message_id: providerMessageId,
        provider_thread_id: null,
        rfc_message_id: rfc,
        direction: "inbound",
        sender: "alyssa@baycarton.example.com",
        recipients: ["ops@harbor.example"],
        sent_at: "2026-10-12T14:00:00Z",
        received_at: "2026-10-12T14:00:05Z",
        historical: false,
        segments: [
          { kind: "body", index: 0, content: "Shipment delayed", content_hash: "h-body" },
        ],
        attachments: [],
      };
    }

    async function events(): Promise<number> {
      const { rows } = await client.query(
        `select count(*)::int as n from public.event_outbox
         where org_id = $1 and event_type = 'supplier.message.received'`,
        [harbor.orgId],
      );
      return rows[0].n;
    }

    it("processes the first copy and stores later copies from another mailbox as ignored", async () => {
      const gmail = await storeMailbox(harbor.orgId, "gmail", "ops@harbor.example");
      const outlook = await storeMailbox(harbor.orgId, "outlook", "buyer@harbor.example");

      const first = await call<Json>("inbox_store_message", message(gmail.connection_id, "g-1"));
      expect(first).toMatchObject({ created: true, processing_state: "pending" });
      expect(await events()).toBe(1);

      const copy = await call<Json>("inbox_store_message", message(outlook.connection_id, "o-1"));
      expect(copy).toMatchObject({ created: true, processing_state: "ignored" });
      expect(await events()).toBe(1);

      // A different Message-ID from the same supplier is a different email.
      const other = await call<Json>(
        "inbox_store_message",
        message(outlook.connection_id, "o-2", "<dup-2@supplier.example>"),
      );
      expect(other).toMatchObject({ created: true, processing_state: "pending" });
      expect(await events()).toBe(2);

      // Re-reading either copy stays a no-op.
      await expect(
        call("inbox_store_message", message(outlook.connection_id, "o-1")),
      ).resolves.toMatchObject({ created: false, processing_state: "ignored" });
      expect(await events()).toBe(2);
    });

    it("keeps the same Message-ID separate across organizations", async () => {
      const gmail = await storeMailbox(harbor.orgId, "gmail", "ops@harbor.example");
      const other = await seedHarbor(client, { mode: "sandbox" });
      await client.query("delete from public.connections where org_id = $1", [other.orgId]);
      const foreign = await storeMailbox(other.orgId, "outlook", "buyer@elsewhere.example");

      await call("inbox_store_message", message(gmail.connection_id, "g-1"));
      const theirs = await call<Json>("inbox_store_message", {
        ...message(foreign.connection_id, "o-1"),
        org_id: other.orgId,
      });
      expect(theirs).toMatchObject({ created: true, processing_state: "pending" });
    });
  });

  it("shows a member only their own organization's mailboxes", async () => {
    const mine = await storeMailbox(harbor.orgId, "outlook", "buyer@harbor.example");
    const other = await seedHarbor(client, { mode: "sandbox" });
    await client.query("delete from public.connections where org_id = $1", [other.orgId]);
    await storeMailbox(other.orgId, "outlook", "buyer@elsewhere.example");

    await client.query("set local role authenticated");
    await client.query(
      "select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)",
      [harbor.ownerId, JSON.stringify({ sub: harbor.ownerId, role: "authenticated" })],
    );
    const visible = await client.query(
      "select id, provider, is_primary from public.connections where provider = 'outlook'",
    );
    expect(visible.rows).toEqual([{ id: mine.connection_id, provider: "outlook", is_primary: true }]);

    // The service-only mailbox RPCs are not callable by a signed-in member.
    await client.query("savepoint rpc_denied");
    await expect(
      client.query("select public.mailbox_load_credential($1::jsonb)", [
        JSON.stringify({ org_id: harbor.orgId, connection_id: mine.connection_id }),
      ]),
    ).rejects.toThrow(/permission denied/);
    await client.query("rollback to savepoint rpc_denied");
    await client.query("reset role");
  });
});
