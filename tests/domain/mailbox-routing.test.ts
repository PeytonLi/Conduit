import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { ActionRecord } from "@/lib/actions/types";
import { RpcError, type RpcClient } from "@/lib/db/messages";
import { parseServerEnv } from "@/lib/env";
import type { GmailApi } from "@/lib/integrations/gmail/api";
import { serializeGmailCredential } from "@/lib/integrations/gmail/credentials";
import { decryptCredential, encryptCredential } from "@/lib/integrations/gmail/crypto";
import {
  createSupplierEmailAdapter,
  type SupplierEmailPayload,
} from "@/lib/integrations/gmail/outbound";
import { createReplayTransport } from "@/lib/integrations/gmail/replay";
import { mailboxHealth } from "@/lib/integrations/mailbox/health";
import { resolveMailboxTransport } from "@/lib/integrations/mailbox/resolve";
import {
  pickMailboxConnection,
  type MailboxConnectionRow,
} from "@/lib/integrations/mailbox/types";
import { serializeOutlookCredential } from "@/lib/integrations/outlook/credentials";
import { GraphApiError } from "@/lib/integrations/outlook/http";
import { createGraphOutlookApi } from "@/lib/integrations/outlook/api";

const key = `v1:${Buffer.alloc(32, 5).toString("base64")}`;
const ORG = "00000000-0000-4000-8000-0000000000a1";
const OTHER_ORG = "00000000-0000-4000-8000-0000000000a2";
const GMAIL_ID = "00000000-0000-4000-8000-0000000000c1";
const OUTLOOK_ID = "00000000-0000-4000-8000-0000000000c2";
const OUTLOOK_B_ID = "00000000-0000-4000-8000-0000000000c3";

const row = (over: Partial<MailboxConnectionRow> & { id: string }): MailboxConnectionRow => ({
  org_id: ORG,
  provider: "outlook",
  status: "healthy",
  is_primary: false,
  created_at: "2026-10-01T00:00:00.000Z",
  ...over,
});

describe("pickMailboxConnection", () => {
  it("prefers the active primary, then the oldest active mailbox", () => {
    const rows = [
      row({ id: "old", created_at: "2026-09-01T00:00:00.000Z" }),
      row({ id: "primary", is_primary: true, created_at: "2026-11-01T00:00:00.000Z" }),
    ];
    expect(pickMailboxConnection(rows, ORG)?.id).toBe("primary");
    rows[1].status = "revoked";
    expect(pickMailboxConnection(rows, ORG)?.id).toBe("old");
    rows[0].status = "disconnected";
    expect(pickMailboxConnection(rows, ORG)).toBeNull();
  });

  it("honors an explicit connection only if it is an active mailbox of the organization", () => {
    const rows = [
      row({ id: "a", is_primary: true }),
      row({ id: "b", provider: "gmail" }),
      row({ id: "dead", status: "expired" }),
      row({ id: "foreign", org_id: OTHER_ORG }),
      row({ id: "erp", provider: "quickbooks" }),
    ];
    expect(pickMailboxConnection(rows, ORG, "b")).toEqual({ id: "b", provider: "gmail", isPrimary: false });
    for (const id of ["dead", "foreign", "erp", "missing"]) {
      expect(pickMailboxConnection(rows, ORG, id)).toBeNull();
    }
  });

  it("ignores non-mailbox providers when choosing a default", () => {
    expect(
      pickMailboxConnection([row({ id: "erp", provider: "quickbooks", is_primary: true })], ORG),
    ).toBeNull();
  });
});

describe("mailboxHealth", () => {
  const now = new Date("2026-11-08T20:00:00Z");
  it("maps status and sync age to one label", () => {
    expect(mailboxHealth({ status: "healthy", last_success_at: "2026-11-08T19:55:00Z" }, now)).toBe("healthy");
    expect(mailboxHealth({ status: "healthy", last_success_at: null }, now)).toBe("healthy");
    expect(mailboxHealth({ status: "healthy", last_success_at: "2026-11-08T19:00:00Z" }, now)).toBe("delayed");
    expect(mailboxHealth({ status: "degraded", last_success_at: null }, now)).toBe("needs_attention");
    expect(mailboxHealth({ status: "expired", last_success_at: null }, now)).toBe("reconnect");
    expect(mailboxHealth({ status: "revoked", last_success_at: null }, now)).toBe("reconnect");
  });
});

interface StoredConnection {
  org_id: string;
  provider: "gmail" | "outlook";
  status: string;
  external_account_id: string;
  plaintext: string | null;
}

function fakeRpc(connections: Record<string, StoredConnection>) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const rpc: RpcClient = {
    async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
      calls.push({ fn, args });
      if (fn === "mailbox_load_credential") {
        const c = connections[String(args.connection_id)];
        if (!c || c.org_id !== args.org_id) throw new RpcError("P0404", "mailbox connection not found");
        return {
          provider: c.provider,
          status: c.status,
          external_account_id: c.external_account_id,
          encrypted_b64: c.plaintext === null ? null : encryptCredential(c.plaintext, key),
          key_version: "v1",
        } as T;
      }
      return { updated: true } as T;
    },
  };
  return { rpc, calls };
}

const env = (appEnv: "replay" | "sandbox" | "live" = "sandbox") =>
  parseServerEnv({
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_PUBLISHABLE_KEY: "p",
    SUPABASE_SECRET_KEY: "s",
    APP_ENV: appEnv,
    CREDENTIAL_ENCRYPTION_KEY: key,
    MICROSOFT_CLIENT_ID: "client-id",
    MICROSOFT_CLIENT_SECRET: "client-secret",
    MICROSOFT_REDIRECT_URI: "https://app.example.test/api/auth/outlook/callback",
  });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Microsoft stub: the token endpoint hands out per-refresh-token access tokens. */
function microsoft(rotateTo?: string) {
  const requests: { url: string; headers: Record<string, string>; body: string }[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    requests.push({ url, headers, body: String(init?.body ?? "") });
    if (url.includes("login.microsoftonline.com")) {
      const refresh = new URLSearchParams(String(init?.body)).get("refresh_token");
      return json({
        access_token: `access-for-${refresh}`,
        expires_in: 3600,
        ...(rotateTo ? { refresh_token: rotateTo } : {}),
      });
    }
    return json({ value: [] });
  };
  return { fetchImpl, requests };
}

const gmailPlain = serializeGmailCredential({ provider: "google", refreshToken: "g-refresh" });
const outlookPlain = (token: string) => serializeOutlookCredential({ provider: "outlook", refreshToken: token });

describe("resolveMailboxTransport", () => {
  const connections = (): Record<string, StoredConnection> => ({
    [GMAIL_ID]: { org_id: ORG, provider: "gmail", status: "healthy", external_account_id: "ops@harbor.example", plaintext: gmailPlain },
    [OUTLOOK_ID]: { org_id: ORG, provider: "outlook", status: "healthy", external_account_id: "buyer@harbor.example", plaintext: outlookPlain("refresh-A") },
    [OUTLOOK_B_ID]: { org_id: ORG, provider: "outlook", status: "healthy", external_account_id: "backup@harbor.example", plaintext: outlookPlain("refresh-B") },
  });

  it("routes each action to the provider and credential of the connection it names", async () => {
    const { rpc, calls } = fakeRpc(connections());
    const ms = microsoft();
    const gmailApi = { id: "gmail-api" } as unknown as GmailApi;
    const createGmailApi = vi.fn(() => gmailApi);
    const base = { rpc, env: env(), orgId: ORG, createGmailApi, fetchImpl: ms.fetchImpl };

    const gmail = await resolveMailboxTransport({ ...base, connectionId: GMAIL_ID });
    expect(gmail).toMatchObject({ provider: "gmail", transport: gmailApi, fromAddress: "ops@harbor.example" });
    expect(createGmailApi).toHaveBeenCalledWith(expect.anything(), { provider: "google", refreshToken: "g-refresh" }, { orgId: ORG });
    expect(ms.requests).toHaveLength(0);

    const outlookA = await resolveMailboxTransport({ ...base, connectionId: OUTLOOK_ID });
    const outlookB = await resolveMailboxTransport({ ...base, connectionId: OUTLOOK_B_ID });
    expect(outlookA).toMatchObject({ provider: "outlook", fromAddress: "buyer@harbor.example" });
    expect(outlookB).toMatchObject({ provider: "outlook", fromAddress: "backup@harbor.example" });

    await outlookA!.transport.findSentByRfcMessageId("<x@y>");
    await outlookB!.transport.findSentByRfcMessageId("<x@y>");
    const graphCalls = ms.requests.filter((r) => r.url.includes("graph.microsoft.com"));
    expect(graphCalls.map((r) => r.headers.authorization)).toEqual([
      "Bearer access-for-refresh-A",
      "Bearer access-for-refresh-B",
    ]);
    expect(calls.filter((c) => c.fn === "mailbox_load_credential").map((c) => c.args.connection_id)).toEqual([
      GMAIL_ID,
      OUTLOOK_ID,
      OUTLOOK_B_ID,
    ]);
  });

  it("resolves nothing for another organization's connection, a dead one, or a missing credential", async () => {
    const stored = connections();
    stored["00000000-0000-4000-8000-0000000000c9"] = { ...stored[OUTLOOK_ID], plaintext: null };
    stored[OUTLOOK_B_ID].status = "revoked";
    const { rpc } = fakeRpc(stored);
    const ms = microsoft();
    const args = { rpc, env: env(), fetchImpl: ms.fetchImpl };

    expect(await resolveMailboxTransport({ ...args, orgId: OTHER_ORG, connectionId: OUTLOOK_ID })).toBeNull();
    expect(await resolveMailboxTransport({ ...args, orgId: ORG, connectionId: OUTLOOK_B_ID })).toBeNull();
    expect(
      await resolveMailboxTransport({ ...args, orgId: ORG, connectionId: "00000000-0000-4000-8000-0000000000c9" }),
    ).toBeNull();
    expect(await resolveMailboxTransport({ ...args, orgId: ORG, connectionId: "00000000-0000-4000-8000-0000000000dd" })).toBeNull();
    expect(ms.requests).toHaveLength(0);
  });

  it("does not hand a Gmail credential to the Outlook client or the reverse", async () => {
    const stored = connections();
    stored[OUTLOOK_ID].plaintext = gmailPlain;
    const { rpc } = fakeRpc(stored);
    const ms = microsoft();
    expect(
      await resolveMailboxTransport({ rpc, env: env(), orgId: ORG, connectionId: OUTLOOK_ID, fetchImpl: ms.fetchImpl }),
    ).toBeNull();
    expect(ms.requests).toHaveLength(0);
  });

  it("stores a rotated refresh token for that connection, encrypted", async () => {
    const { rpc, calls } = fakeRpc(connections());
    const ms = microsoft("refresh-A-rotated");
    const resolved = await resolveMailboxTransport({
      rpc,
      env: env(),
      orgId: ORG,
      connectionId: OUTLOOK_ID,
      fetchImpl: ms.fetchImpl,
    });
    await resolved!.transport.findSentByRfcMessageId("<x@y>");
    const update = calls.find((c) => c.fn === "mailbox_update_credential")!;
    expect(update.args).toMatchObject({ org_id: ORG, connection_id: OUTLOOK_ID, key_version: "v1" });
    expect(
      JSON.parse(decryptCredential(String(update.args.encrypted_b64), key, "v1")),
    ).toEqual({ provider: "outlook", refreshToken: "refresh-A-rotated" });
    expect(JSON.stringify(update.args)).not.toContain("refresh-A-rotated");
  });

  it("caches the access token between calls and refreshes it once per expiry", async () => {
    const { rpc } = fakeRpc(connections());
    const ms = microsoft();
    const resolved = await resolveMailboxTransport({
      rpc,
      env: env(),
      orgId: ORG,
      connectionId: OUTLOOK_ID,
      fetchImpl: ms.fetchImpl,
    });
    await resolved!.transport.findSentByRfcMessageId("<a@y>");
    await resolved!.transport.findSentByRfcMessageId("<b@y>");
    expect(ms.requests.filter((r) => r.url.includes("login.microsoftonline.com"))).toHaveLength(1);
  });
});

describe("Outlook and replay mode", () => {
  it("never builds an Outlook transport, or calls Microsoft, in replay", async () => {
    const { rpc } = fakeRpc({
      [OUTLOOK_ID]: { org_id: ORG, provider: "outlook", status: "healthy", external_account_id: "buyer@harbor.example", plaintext: outlookPlain("r") },
    });
    const fetchImpl = vi.fn(async () => json({}));
    const resolved = await resolveMailboxTransport({
      rpc,
      env: env("replay"),
      orgId: ORG,
      connectionId: OUTLOOK_ID,
      fetchImpl,
    });
    expect(resolved).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a Graph client created for a replay environment fails before reaching the network", async () => {
    // Even when something builds the client by hand, the guarded fetch stops it.
    const { createMicrosoftFetch } = await import("@/lib/integrations/outlook/http");
    const underlying = vi.fn(async () => json({}));
    const api = createGraphOutlookApi({
      getAccessToken: async () => "tok",
      fetchImpl: createMicrosoftFetch({ appEnv: () => "replay", fetchImpl: underlying }),
    });
    await expect(api.getProfile()).rejects.toThrow("replay");
    expect(underlying).not.toHaveBeenCalled();
  });
});

describe("supplier email adapter over an Outlook transport", () => {
  const payload: SupplierEmailPayload = {
    template: "quote_request",
    connection_id: OUTLOOK_ID,
    contact_id: "00000000-0000-4000-8000-0000000000bb",
    to: "alyssa@baycarton.example.com",
    subject: "Quote needed",
    thread: null,
    facts: {
      item_sku: "CARTON-302015",
      item_description: "Shipping carton",
      specification: {},
      quantity: 600,
      unit: "carton",
      destination_name: "Main Warehouse",
      needed_by_local: "2026-10-20",
      quote_fields: ["unit_price"],
    },
    question: "",
  };
  const action = (over: Partial<ActionRecord> = {}): ActionRecord => ({
    id: "act-1",
    orgId: ORG,
    caseId: "case-1",
    kind: "supplier_email",
    idempotencyKey: "k",
    payloadHash: "h",
    payload,
    providerRef: null,
    mode: "live",
    ...over,
  });

  function build(opts: {
    appEnv?: "replay" | "sandbox" | "live";
    send?: () => Promise<{ id: string; threadId: string }>;
    found?: { id: string; threadId: string } | null;
  }) {
    const sendStructured = vi.fn(opts.send ?? (async () => ({ id: "out-1", threadId: "conv-1" })));
    const transport = {
      send: vi.fn(),
      sendStructured,
      findSentByRfcMessageId: vi.fn(async () => opts.found ?? null),
    };
    const transportFor = vi.fn(async () => transport);
    const replay = createReplayTransport();
    const adapter = createSupplierEmailAdapter({
      appEnv: () => opts.appEnv ?? "sandbox",
      transportFor,
      loadContact: async () => ({
        normalized_address: "alyssa@baycarton.example.com",
        outreach_approved_at: "2026-01-01T00:00:00Z",
        permitted_channels: ["email"],
        supplier_id: "s1",
      }),
      fromAddressFor: () => "buyer@harbor.example",
      replayTransport: replay,
    });
    return { adapter, transport, transportFor, replay };
  }

  it("sends structured mail with a Message-ID from the mailbox's own domain", async () => {
    const { adapter, transport } = build({});
    const result = await adapter.dispatch(action());
    expect(result).toMatchObject({ outcome: "submitted", providerRef: "out-1" });
    expect(transport.send).not.toHaveBeenCalled();
    expect(transport.sendStructured).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "alyssa@baycarton.example.com",
        rfcMessageId: "<conduit.act-1@harbor.example>",
      }),
    );
  });

  it("confirms instead of resending when the message is already in Sent Items", async () => {
    const { adapter, transport } = build({ found: { id: "sent-1", threadId: "conv-1" } });
    await expect(adapter.dispatch(action())).resolves.toMatchObject({
      outcome: "confirmed",
      providerRef: "sent-1",
    });
    expect(transport.sendStructured).not.toHaveBeenCalled();
  });

  it("reports an uncertain send as unknown, so the dispatcher reconciles instead of retrying", async () => {
    for (const status of [429, 503]) {
      const { adapter } = build({
        send: async () => {
          throw new GraphApiError(status, null);
        },
      });
      await expect(adapter.dispatch(action())).resolves.toMatchObject({ outcome: "unknown" });
    }
    const timeout = build({
      send: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(timeout.adapter.dispatch(action())).resolves.toMatchObject({ outcome: "unknown" });
  });

  it("reports a definite refusal as failed", async () => {
    for (const error of [new GraphApiError(400, "invalid_grant"), new GraphApiError(403, "ErrorAccessDenied")]) {
      const { adapter } = build({
        send: async () => {
          throw error;
        },
      });
      await expect(adapter.dispatch(action())).resolves.toMatchObject({ outcome: "failed" });
    }
  });

  it("reconciles by Message-ID and never calls a miss failed", async () => {
    const hit = build({ found: { id: "sent-7", threadId: "c" } });
    await expect(hit.adapter.findResult(action())).resolves.toMatchObject({
      outcome: "confirmed",
      providerRef: "sent-7",
    });
    const miss = build({});
    await expect(miss.adapter.findResult(action())).resolves.toMatchObject({ outcome: "unknown" });
  });

  it("uses only the replay transport in replay, whatever mailbox the action names", async () => {
    const { adapter, transportFor, transport, replay } = build({ appEnv: "replay" });
    const result = await adapter.dispatch(action());
    expect(result.outcome).not.toBe("failed");
    expect(result.safeSummary).toMatch(/replay/);
    expect(replay.sent).toHaveLength(1);
    expect(transportFor).not.toHaveBeenCalled();
    expect(transport.sendStructured).not.toHaveBeenCalled();

    const replayAction = build({ appEnv: "live" });
    await replayAction.adapter.dispatch(action({ mode: "replay" }));
    expect(replayAction.transportFor).not.toHaveBeenCalled();
  });
});
