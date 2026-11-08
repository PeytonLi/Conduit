import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { google } from "googleapis";
import { describe, expect, it, vi } from "vitest";
import type { RpcClient } from "@/lib/db/messages";
import { parseServerEnv, type ServerEnv } from "@/lib/env";
import type { GmailApi } from "@/lib/integrations/gmail/api";
import { encryptCredential, credentialKeyVersion } from "@/lib/integrations/gmail/crypto";
import { serializeGmailCredential } from "@/lib/integrations/gmail/credentials";
import {
  GMAIL_WATCH_RENEW_BEFORE_MS,
  GMAIL_WATCH_RENEW_CRON,
  createGoogleIdTokenVerifier,
  decodeGmailNotification,
  gmailPushVerificationConfig,
  gmailWatchEnabled,
  handleGmailPushWebhook,
  parseGmailWatchStates,
  registerGmailWatch,
  selectWatchesDue,
  verifyPubSubPushAuth,
  type GmailPushDeps,
  type GmailWatchState,
  type PubSubTokenVerifier,
} from "@/lib/integrations/gmail/push";
import {
  findPushConnections,
  listWatchesDue,
  registerWatchForConnection,
  setupWatchOnConnect,
  syncGmailConnectionById,
} from "@/lib/integrations/gmail/runtime";

const TOPIC = "projects/conduit-test/topics/gmail-push";
const AUDIENCE = "https://app.example.test/api/webhooks/gmail";
const SERVICE_ACCOUNT = "gmail-push@conduit-test.iam.gserviceaccount.com";
const KEY = `v1:${Buffer.alloc(32, 7).toString("base64")}`;
const NOW = new Date("2026-11-08T12:00:00Z");

const baseEnv = {
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_PUBLISHABLE_KEY: "pub",
  SUPABASE_SECRET_KEY: "secret",
  APP_BASE_URL: "https://app.example.test",
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
  GOOGLE_REDIRECT_URI: "https://app.example.test/api/auth/gmail/callback",
  CREDENTIAL_ENCRYPTION_KEY: KEY,
  GMAIL_PUBSUB_TOPIC: TOPIC,
  GMAIL_PUBSUB_SERVICE_ACCOUNT_EMAIL: SERVICE_ACCOUNT,
};

function env(over: Record<string, string> = {}): ServerEnv {
  return parseServerEnv({ APP_ENV: "sandbox", ...baseEnv, ...over });
}

// ---------------------------------------------------------------------------
// Real JWT signing so Google's verifier logic (signature, aud, exp) is exercised
// ---------------------------------------------------------------------------

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signJwt(
  claims: Record<string, unknown>,
  privateKey: KeyObject = keys.privateKey,
): string {
  const seconds = Math.floor(Date.now() / 1000);
  const header = b64url({ alg: "RS256", typ: "JWT", kid: "k1" });
  const payload = b64url({
    iss: "https://accounts.google.com",
    aud: AUDIENCE,
    sub: "1234567890",
    email: SERVICE_ACCOUNT,
    email_verified: true,
    iat: seconds,
    exp: seconds + 3600,
    ...claims,
  });
  const signature = createSign("RSA-SHA256")
    .update(`${header}.${payload}`)
    .sign(privateKey)
    .toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function realVerifier(): PubSubTokenVerifier {
  const client = new google.auth.OAuth2();
  client.getFederatedSignonCertsAsync = (async () => ({
    certs: { k1: keys.publicKey.export({ type: "spki", format: "pem" }) as string },
    format: "PEM",
  })) as unknown as typeof client.getFederatedSignonCertsAsync;
  return createGoogleIdTokenVerifier(client);
}

const config = { audience: AUDIENCE, serviceAccountEmail: SERVICE_ACCOUNT };

describe("Gmail push authentication", () => {
  it("accepts a Google-signed token for the configured audience and service account", async () => {
    const result = await verifyPubSubPushAuth(
      `Bearer ${signJwt({})}`,
      config,
      realVerifier(),
    );
    expect(result).toEqual({ ok: true });
  });

  it("rejects missing, malformed, forged, wrong-audience and expired tokens", async () => {
    const verify = realVerifier();
    const seconds = Math.floor(Date.now() / 1000);
    const cases: [string | null, string][] = [
      [null, "missing_bearer"],
      ["Basic abc", "missing_bearer"],
      ["Bearer not-a-jwt", "invalid_token"],
      [`Bearer ${signJwt({}, otherKeys.privateKey)}`, "invalid_token"],
      [`Bearer ${signJwt({ aud: "https://evil.example.test/hook" })}`, "invalid_token"],
      [`Bearer ${signJwt({ iat: seconds - 7200, exp: seconds - 3600 })}`, "invalid_token"],
      [`Bearer ${signJwt({ iss: "https://evil.example.test" })}`, "invalid_token"],
    ];
    for (const [header, reason] of cases) {
      expect(await verifyPubSubPushAuth(header, config, verify)).toEqual({ ok: false, reason });
    }
  });

  it("rejects a valid Google token minted for a different service account or unverified email", async () => {
    const verify = realVerifier();
    expect(
      await verifyPubSubPushAuth(
        `Bearer ${signJwt({ email: "attacker@evil.iam.gserviceaccount.com" })}`,
        config,
        verify,
      ),
    ).toEqual({ ok: false, reason: "wrong_service_account" });
    expect(
      await verifyPubSubPushAuth(
        `Bearer ${signJwt({ email_verified: false })}`,
        config,
        verify,
      ),
    ).toEqual({ ok: false, reason: "unverified_email" });
  });

  it("derives the audience from APP_BASE_URL and fails closed when unconfigured", () => {
    expect(gmailPushVerificationConfig(env())).toEqual(config);
    expect(
      gmailPushVerificationConfig(env({ GMAIL_PUBSUB_AUDIENCE: "custom-audience" }))?.audience,
    ).toBe("custom-audience");
    expect(gmailPushVerificationConfig(env({ GMAIL_PUBSUB_SERVICE_ACCOUNT_EMAIL: "" }))).toBeNull();
    expect(gmailPushVerificationConfig(env({ APP_BASE_URL: "" }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Fakes shared by webhook/runtime tests
// ---------------------------------------------------------------------------

function notificationBody(emailAddress: string, historyId: string | number = "900"): string {
  return JSON.stringify({
    message: {
      data: Buffer.from(JSON.stringify({ emailAddress, historyId })).toString("base64"),
      messageId: "m1",
    },
    subscription: "projects/conduit-test/subscriptions/gmail-push",
  });
}

function fakeGmail(over: Partial<GmailApi> = {}): GmailApi & {
  historyCalls: string[];
} {
  const historyCalls: string[] = [];
  return {
    historyCalls,
    async getProfile() {
      return { emailAddress: "ops@acme.example", historyId: "H9" };
    },
    async listMessages() {
      return { ids: [] };
    },
    async listHistory({ startHistoryId }) {
      historyCalls.push(startHistoryId);
      return { messageIds: ["msg-1"], historyId: "H2" };
    },
    async getRaw(id) {
      return {
        id,
        threadId: `t-${id}`,
        labelIds: ["INBOX"],
        internalDate: 0,
        raw: Buffer.from("From: sup@vendor.example\r\nTo: ops@acme.example\r\nSubject: Delay\r\n\r\nShipment slips."),
      };
    },
    async send() {
      return { id: "x", threadId: "t" };
    },
    async findSentByRfcMessageId() {
      return null;
    },
    ...over,
  };
}

interface FakeConnection {
  org_id: string;
  connection_id: string;
  environment_mode: string;
  external_account_id: string;
  watch_topic?: string | null;
  watch_expires_at?: string | null;
  sync_cursor?: string | null;
}

function fakeRpc(connections: FakeConnection[]) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const rpc: RpcClient = {
    async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
      calls.push({ fn, args });
      const find = () =>
        connections.find(
          (c) => c.org_id === args.org_id && c.connection_id === args.connection_id,
        );
      switch (fn) {
        case "gmail_list_watch_state": {
          const rows = connections.filter(
            (c) =>
              (!args.org_id || c.org_id === args.org_id) &&
              (!args.connection_id || c.connection_id === args.connection_id) &&
              (!args.email ||
                c.external_account_id.toLowerCase() === String(args.email).toLowerCase()),
          );
          return rows.map((c) => ({
            org_id: c.org_id,
            connection_id: c.connection_id,
            environment_mode: c.environment_mode,
            external_account_id: c.external_account_id,
            watch_topic: c.watch_topic ?? null,
            watch_expires_at: c.watch_expires_at ?? null,
          })) as T;
        }
        case "gmail_load_credential": {
          const c = find();
          if (!c) throw new Error("gmail connection not found");
          return {
            status: "healthy",
            external_account_id: c.external_account_id,
            sync_cursor: c.sync_cursor ?? null,
            encrypted_b64: encryptCredential(
              serializeGmailCredential({ provider: "google", refreshToken: "refresh-secret" }),
              KEY,
            ),
            key_version: credentialKeyVersion(KEY),
            expires_at: null,
          } as T;
        }
        case "gmail_record_watch": {
          const c = find();
          if (c) {
            c.watch_topic = args.topic as string;
            c.watch_expires_at = args.expires_at as string;
          }
          return { updated: Boolean(c) } as T;
        }
        case "gmail_advance_cursor": {
          const c = find();
          if (c && (c.sync_cursor ?? null) === args.expected_cursor) {
            c.sync_cursor = args.new_cursor as string;
            return { advanced: true } as T;
          }
          return { advanced: false } as T;
        }
        case "inbox_store_message":
          return { source_message_id: "sm", created: true, processing_state: "pending" } as T;
        case "gmail_set_status":
          return { updated: true } as T;
        default:
          throw new Error(`unexpected rpc ${fn}`);
      }
    },
  };
  return { rpc, calls };
}

const ORG_A = "00000000-0000-4000-8000-00000000000a";
const ORG_B = "00000000-0000-4000-8000-00000000000b";
const CONN_A = "00000000-0000-4000-8000-0000000000a1";
const CONN_B = "00000000-0000-4000-8000-0000000000b1";

describe("Gmail push notification decoding", () => {
  it("decodes the Pub/Sub envelope and coerces numeric history ids", () => {
    expect(decodeGmailNotification(notificationBody("ops@acme.example", 77))).toEqual({
      emailAddress: "ops@acme.example",
      historyId: "77",
    });
  });

  it("rejects malformed bodies without throwing", () => {
    expect(decodeGmailNotification("not json")).toBeNull();
    expect(decodeGmailNotification("{}")).toBeNull();
    expect(
      decodeGmailNotification(
        JSON.stringify({ message: { data: Buffer.from("[1]").toString("base64") } }),
      ),
    ).toBeNull();
    expect(
      decodeGmailNotification(
        JSON.stringify({
          message: { data: Buffer.from(JSON.stringify({ emailAddress: "bad" })).toString("base64") },
        }),
      ),
    ).toBeNull();
  });
});

describe("Gmail push webhook", () => {
  function deps(over: Partial<GmailPushDeps> = {}): GmailPushDeps {
    return {
      env: env(),
      verify: vi.fn(async () => ({ email: SERVICE_ACCOUNT, email_verified: true })),
      findConnections: vi.fn(async () => []),
      syncConnection: vi.fn(async () => ({ ok: true, stored: 0, duplicates: 0, cursor: null })),
      ...over,
    };
  }

  it("runs the shared history-cursor sync with a mocked GmailApi for the org connection", async () => {
    const connections: FakeConnection[] = [
      {
        org_id: ORG_A,
        connection_id: CONN_A,
        environment_mode: "sandbox",
        external_account_id: "Ops@Acme.example",
        sync_cursor: "H1",
      },
      {
        org_id: ORG_B,
        connection_id: CONN_B,
        environment_mode: "sandbox",
        external_account_id: "other@else.example",
        sync_cursor: "Z1",
      },
    ];
    const { rpc, calls } = fakeRpc(connections);
    const api = fakeGmail();
    const publish = vi.fn(async () => {});
    const parsedEnv = env();

    const response = await handleGmailPushWebhook(
      notificationBody("ops@acme.example"),
      "Bearer token",
      {
        env: parsedEnv,
        verify: async () => ({ email: SERVICE_ACCOUNT, email_verified: true }),
        findConnections: (email) => findPushConnections(rpc, email),
        syncConnection: (c) =>
          syncGmailConnectionById({
            rpc,
            env: parsedEnv,
            orgId: c.orgId,
            connectionId: c.connectionId,
            publish,
            createApi: () => api,
          }),
      },
    );

    expect(response).toEqual({
      status: 200,
      body: { ok: true, connections: 1, synced: 1 },
    });
    // Same path as the poller: partial sync from the stored cursor, then CAS advance.
    expect(api.historyCalls).toEqual(["H1"]);
    const stored = calls.filter((c) => c.fn === "inbox_store_message");
    expect(stored).toHaveLength(1);
    expect(stored[0].args).toMatchObject({
      org_id: ORG_A,
      connection_id: CONN_A,
      provider_message_id: "msg-1",
      direction: "inbound",
      historical: false,
    });
    expect(connections[0].sync_cursor).toBe("H2");
    expect(connections[1].sync_cursor).toBe("Z1");
    expect(publish).toHaveBeenCalledTimes(1);
    // Org B was never touched.
    expect(calls.some((c) => c.args.org_id === ORG_B && c.fn !== "gmail_list_watch_state")).toBe(
      false,
    );
  });

  it("syncs each organization that connected the same mailbox, scoped by its own org", async () => {
    const synced: unknown[] = [];
    const response = await handleGmailPushWebhook(
      notificationBody("ops@acme.example"),
      "Bearer token",
      deps({
        findConnections: async () => [
          { orgId: ORG_A, connectionId: CONN_A },
          { orgId: ORG_B, connectionId: CONN_B },
        ],
        syncConnection: async (c) => {
          synced.push(c);
          return { ok: true, stored: 1, duplicates: 0, cursor: "H2" };
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(synced).toEqual([
      { orgId: ORG_A, connectionId: CONN_A },
      { orgId: ORG_B, connectionId: CONN_B },
    ]);
  });

  it("never syncs, loads connections or contacts Google in replay mode", async () => {
    const d = deps({ env: env({ APP_ENV: "replay" }) });
    const response = await handleGmailPushWebhook(notificationBody("ops@acme.example"), null, d);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ignored: "replay" });
    expect(d.verify).not.toHaveBeenCalled();
    expect(d.findConnections).not.toHaveBeenCalled();
    expect(d.syncConnection).not.toHaveBeenCalled();
  });

  it("fails closed with 503 when verification settings are missing", async () => {
    const d = deps({ env: env({ GMAIL_PUBSUB_SERVICE_ACCOUNT_EMAIL: "" }) });
    const response = await handleGmailPushWebhook(
      notificationBody("ops@acme.example"),
      "Bearer token",
      d,
    );
    expect(response.status).toBe(503);
    expect(d.syncConnection).not.toHaveBeenCalled();
  });

  it("returns 401 without syncing when authentication fails and never logs the token", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = deps({
      verify: vi.fn(async () => {
        throw new Error("bad signature");
      }),
    });
    const response = await handleGmailPushWebhook(
      notificationBody("ops@acme.example"),
      "Bearer super-secret-token",
      d,
    );
    expect(response.status).toBe(401);
    expect(d.findConnections).not.toHaveBeenCalled();
    expect(d.syncConnection).not.toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("super-secret-token");
    warn.mockRestore();
  });

  it("acks an authenticated but malformed notification without syncing", async () => {
    const d = deps();
    const response = await handleGmailPushWebhook("{}", "Bearer token", d);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: false, code: "invalid_notification" });
    expect(d.syncConnection).not.toHaveBeenCalled();
  });

  it("acks a notification for an unknown mailbox", async () => {
    const response = await handleGmailPushWebhook(
      notificationBody("nobody@example.test"),
      "Bearer token",
      deps(),
    );
    expect(response).toEqual({ status: 200, body: { ok: true, connections: 0, synced: 0 } });
  });

  it("returns 500 so Pub/Sub redelivers when a sync throws, without leaking details", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await handleGmailPushWebhook(
      notificationBody("ops@acme.example"),
      "Bearer token",
      deps({
        findConnections: async () => [{ orgId: ORG_A, connectionId: CONN_A }],
        syncConnection: async () => {
          throw new Error("store boom");
        },
      }),
    );
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ ok: false, code: "sync_failed", synced: 0, failed: 1 });
    error.mockRestore();
  });

  it("acks provider failures that the sync already recorded; the poll retries", async () => {
    const response = await handleGmailPushWebhook(
      notificationBody("ops@acme.example"),
      "Bearer token",
      deps({
        findConnections: async () => [{ orgId: ORG_A, connectionId: CONN_A }],
        syncConnection: async () => ({
          ok: false,
          stored: 0,
          duplicates: 0,
          cursor: "H1",
          status: "degraded",
        }),
      }),
    );
    expect(response.status).toBe(200);
  });
});

describe("Gmail watch renewal scheduling", () => {
  const state = (over: Partial<GmailWatchState> = {}): GmailWatchState => ({
    orgId: ORG_A,
    connectionId: CONN_A,
    environmentMode: "sandbox",
    externalAccountId: "ops@acme.example",
    watchTopic: TOPIC,
    watchExpiresAt: new Date(NOW.getTime() + 5 * 24 * 60 * 60 * 1000),
    ...over,
  });
  const opts = { topic: TOPIC, now: NOW };

  it("registers connections with no watch, a different topic or an unknown expiry", () => {
    const due = selectWatchesDue(
      [
        state({ connectionId: "never", watchTopic: null, watchExpiresAt: null }),
        state({ connectionId: "topic", watchTopic: "projects/old/topics/old" }),
        state({ connectionId: "noexp", watchExpiresAt: null }),
      ],
      opts,
    );
    expect(due.map((s) => s.connectionId)).toEqual(["never", "topic", "noexp"]);
  });

  it("renews within the renewal window and leaves fresh watches alone", () => {
    const edge = new Date(NOW.getTime() + GMAIL_WATCH_RENEW_BEFORE_MS);
    const justOutside = new Date(edge.getTime() + 1);
    const due = selectWatchesDue(
      [
        state({ connectionId: "expired", watchExpiresAt: new Date(NOW.getTime() - 1000) }),
        state({ connectionId: "edge", watchExpiresAt: edge }),
        state({ connectionId: "outside", watchExpiresAt: justOutside }),
        state({ connectionId: "fresh" }),
      ],
      opts,
    );
    expect(due.map((s) => s.connectionId)).toEqual(["expired", "edge"]);
  });

  it("never schedules replay-mode organizations", () => {
    expect(
      selectWatchesDue(
        [state({ environmentMode: "replay", watchTopic: null, watchExpiresAt: null })],
        opts,
      ),
    ).toEqual([]);
  });

  it("runs the renewal cron at least every 6 hours, inside the window", () => {
    expect(GMAIL_WATCH_RENEW_CRON).toBe("17 */6 * * *");
    expect(GMAIL_WATCH_RENEW_BEFORE_MS).toBeGreaterThan(6 * 60 * 60 * 1000);
  });

  it("parses watch rows from the RPC boundary and rejects bad shapes", () => {
    const [parsed] = parseGmailWatchStates([
      {
        org_id: ORG_A,
        connection_id: CONN_A,
        environment_mode: "sandbox",
        external_account_id: "ops@acme.example",
        watch_topic: TOPIC,
        watch_expires_at: "2026-11-12T00:00:00Z",
      },
    ]);
    expect(parsed.watchExpiresAt?.toISOString()).toBe("2026-11-12T00:00:00.000Z");
    expect(() => parseGmailWatchStates([{ org_id: 1 }])).toThrow();
  });

  it("lists due watches only from the Google provider with a topic configured", async () => {
    const soon = new Date(NOW.getTime() + 60 * 60 * 1000).toISOString();
    const { rpc } = fakeRpc([
      {
        org_id: ORG_A,
        connection_id: CONN_A,
        environment_mode: "sandbox",
        external_account_id: "ops@acme.example",
        watch_topic: TOPIC,
        watch_expires_at: soon,
      },
      {
        org_id: ORG_B,
        connection_id: CONN_B,
        environment_mode: "replay",
        external_account_id: "r@acme.example",
      },
    ]);
    const now = () => NOW;
    expect(
      (await listWatchesDue({ rpc, env: env(), now })).map((s) => s.connectionId),
    ).toEqual([CONN_A]);
    expect(await listWatchesDue({ rpc, env: env({ GMAIL_PUBSUB_TOPIC: "" }), now })).toEqual([]);
    expect(await listWatchesDue({ rpc, env: env({ GMAIL_PROVIDER: "composio" }), now })).toEqual(
      [],
    );
  });
});

describe("Gmail watch registration", () => {
  const expiration = new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000);

  function connectionList(over: Partial<FakeConnection> = {}): FakeConnection[] {
    return [
      {
        org_id: ORG_A,
        connection_id: CONN_A,
        environment_mode: "sandbox",
        external_account_id: "ops@acme.example",
        ...over,
      },
    ];
  }

  it("calls users.watch with the env topic and stores the expiration for the org connection", async () => {
    const connections = connectionList();
    const { rpc, calls } = fakeRpc(connections);
    const watch = vi.fn(async () => ({ historyId: "500", expiration }));
    const outcome = await registerWatchForConnection({
      rpc,
      env: env(),
      orgId: ORG_A,
      connectionId: CONN_A,
      now: () => NOW,
      createApi: () => fakeGmail({ watch }),
    });
    expect(outcome).toEqual({ ok: true, expiresAt: expiration });
    expect(watch).toHaveBeenCalledWith({ topicName: TOPIC });
    expect(calls.find((c) => c.fn === "gmail_record_watch")?.args).toEqual({
      org_id: ORG_A,
      connection_id: CONN_A,
      topic: TOPIC,
      expires_at: expiration.toISOString(),
    });
    expect(connections[0].watch_topic).toBe(TOPIC);
  });

  it("does not record anything when Google rejects the watch or returns a past expiry", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { rpc, calls } = fakeRpc(connectionList());
    const rejected = await registerWatchForConnection({
      rpc,
      env: env(),
      orgId: ORG_A,
      connectionId: CONN_A,
      createApi: () =>
        fakeGmail({
          watch: async () => {
            throw Object.assign(new Error("Bearer ya29.secret-token denied"), { code: 403 });
          },
        }),
    });
    expect(rejected).toMatchObject({ ok: false, reason: "provider_error", kind: "invalid_request" });
    expect(JSON.stringify(error.mock.calls)).not.toContain("ya29.secret-token");

    const stale = await registerGmailWatch({
      api: fakeGmail({
        watch: async () => ({ historyId: "1", expiration: new Date(NOW.getTime() - 1) }),
      }),
      topic: TOPIC,
      now: NOW,
      record: async () => {
        throw new Error("must not record");
      },
    });
    expect(stale).toEqual({ ok: false, reason: "invalid_response" });
    expect(calls.some((c) => c.fn === "gmail_record_watch")).toBe(false);
    error.mockRestore();
  });

  it("reports unsupported providers instead of throwing", async () => {
    expect(
      await registerGmailWatch({
        api: fakeGmail(),
        topic: TOPIC,
        now: NOW,
        record: async () => {},
      }),
    ).toEqual({ ok: false, reason: "unsupported" });
  });

  it("replay mode registers no watch and never builds a Google client or touches the database", async () => {
    const createApi = vi.fn();
    const { rpc, calls } = fakeRpc(connectionList());
    const replayEnv = env({ APP_ENV: "replay" });
    expect(gmailWatchEnabled(replayEnv)).toBe(false);
    expect(
      await registerWatchForConnection({
        rpc,
        env: replayEnv,
        orgId: ORG_A,
        connectionId: CONN_A,
        createApi,
      }),
    ).toEqual({ ok: false, reason: "skipped" });
    expect(
      await setupWatchOnConnect({
        rpc,
        env: replayEnv,
        orgId: ORG_A,
        connectionId: CONN_A,
        createApi,
      }),
    ).toEqual({ ok: false, reason: "skipped" });
    expect(createApi).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("skips replay-mode organizations even when the process is sandbox", async () => {
    const createApi = vi.fn();
    const { rpc, calls } = fakeRpc(connectionList({ environment_mode: "replay" }));
    const outcome = await setupWatchOnConnect({
      rpc,
      env: env(),
      orgId: ORG_A,
      connectionId: CONN_A,
      createApi,
    });
    expect(outcome).toEqual({ ok: false, reason: "skipped" });
    expect(createApi).not.toHaveBeenCalled();
    expect(calls.map((c) => c.fn)).toEqual(["gmail_list_watch_state"]);
  });

  it("setup on connect never throws when storage fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const outcome = await setupWatchOnConnect({
      rpc: {
        rpc: async () => {
          throw new Error("db down");
        },
      },
      env: env(),
      orgId: ORG_A,
      connectionId: CONN_A,
    });
    expect(outcome.ok).toBe(false);
    error.mockRestore();
  });

  it("does not register watches when push is not configured or the provider is Composio", () => {
    expect(gmailWatchEnabled(env())).toBe(true);
    expect(gmailWatchEnabled(env({ GMAIL_PUBSUB_TOPIC: "" }))).toBe(false);
    expect(
      gmailWatchEnabled(
        env({
          GMAIL_PROVIDER: "composio",
          COMPOSIO_API_KEY: "k",
          COMPOSIO_GMAIL_AUTH_CONFIG_ID: "ac",
        }),
      ),
    ).toBe(false);
  });
});

describe("Gmail push environment", () => {
  it("accepts a full topic name and rejects malformed topics or service accounts", () => {
    expect(env().GMAIL_PUBSUB_TOPIC).toBe(TOPIC);
    expect(env({ GMAIL_PUBSUB_TOPIC: "" }).GMAIL_PUBSUB_TOPIC).toBe("");
    expect(() => env({ GMAIL_PUBSUB_TOPIC: "gmail-push" })).toThrow();
    expect(() => env({ GMAIL_PUBSUB_SERVICE_ACCOUNT_EMAIL: "not-an-email" })).toThrow();
  });
});
