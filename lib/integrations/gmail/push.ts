import { google } from "googleapis";
import { z } from "zod";
import { classifyGmailError, type GmailApi } from "./api";
import { gmailPollEnabled, type GmailPollEnv, type SyncResult } from "./sync";
import { safeErrorLogFields } from "@/lib/safe-error";

export const GMAIL_PUSH_WEBHOOK_PATH = "/api/webhooks/gmail";
/** Gmail watches last at most 7 days; renew with a full day of slack. */
export const GMAIL_WATCH_RENEW_BEFORE_MS = 24 * 60 * 60 * 1000;
export const GMAIL_WATCH_RENEW_CRON = "17 */6 * * *";

export interface GmailPushEnv extends GmailPollEnv {
  APP_BASE_URL?: string;
  GMAIL_PUBSUB_TOPIC?: string;
  GMAIL_PUBSUB_AUDIENCE?: string;
  GMAIL_PUBSUB_SERVICE_ACCOUNT_EMAIL?: string;
}

/**
 * Watches are only registered for the direct Google provider (Composio does
 * not expose users.watch), never in replay, and only when the poll itself is
 * runnable: push is additive, never a replacement.
 */
export function gmailWatchEnabled(env: GmailPushEnv): boolean {
  if (env.APP_ENV === "replay") return false;
  if (env.GMAIL_PROVIDER === "composio") return false;
  if (!env.GMAIL_PUBSUB_TOPIC) return false;
  return gmailPollEnabled(env);
}

export interface PushVerificationConfig {
  audience: string;
  serviceAccountEmail: string;
}

/** Null means push receipt is not configured and the webhook must fail closed. */
export function gmailPushVerificationConfig(
  env: GmailPushEnv,
): PushVerificationConfig | null {
  const serviceAccountEmail = env.GMAIL_PUBSUB_SERVICE_ACCOUNT_EMAIL;
  if (!serviceAccountEmail) return null;
  let audience = env.GMAIL_PUBSUB_AUDIENCE;
  if (!audience && env.APP_BASE_URL) {
    try {
      audience = new URL(GMAIL_PUSH_WEBHOOK_PATH, new URL(env.APP_BASE_URL).origin).toString();
    } catch {
      audience = undefined;
    }
  }
  if (!audience) return null;
  return { audience, serviceAccountEmail };
}

// ---------------------------------------------------------------------------
// Pub/Sub push authentication (OIDC bearer token signed by Google)
// ---------------------------------------------------------------------------

export interface VerifiedTokenClaims {
  email?: string;
  email_verified?: boolean;
}

/** Verifies signature, issuer, expiry and audience; throws on any failure. */
export type PubSubTokenVerifier = (
  idToken: string,
  audience: string,
) => Promise<VerifiedTokenClaims>;

let sharedOAuthClient: InstanceType<typeof google.auth.OAuth2> | null = null;

/** Uses Google's published signing certs (cached by the auth client). */
export function createGoogleIdTokenVerifier(
  client?: Pick<InstanceType<typeof google.auth.OAuth2>, "verifyIdToken">,
): PubSubTokenVerifier {
  return async (idToken, audience) => {
    const oauth = client ?? (sharedOAuthClient ??= new google.auth.OAuth2());
    const ticket = await oauth.verifyIdToken({ idToken, audience });
    const payload = ticket.getPayload();
    if (!payload) throw new Error("token has no payload");
    return { email: payload.email, email_verified: payload.email_verified };
  };
}

export type PushAuthFailure =
  | "missing_bearer"
  | "invalid_token"
  | "wrong_service_account"
  | "unverified_email";

export type PushAuthResult = { ok: true } | { ok: false; reason: PushAuthFailure };

export async function verifyPubSubPushAuth(
  authorization: string | null,
  config: PushVerificationConfig,
  verify: PubSubTokenVerifier,
): Promise<PushAuthResult> {
  const match = authorization?.match(/^Bearer\s+(\S+)$/i);
  if (!match) return { ok: false, reason: "missing_bearer" };
  let claims: VerifiedTokenClaims;
  try {
    claims = await verify(match[1], config.audience);
  } catch {
    return { ok: false, reason: "invalid_token" };
  }
  if (claims.email_verified !== true) return { ok: false, reason: "unverified_email" };
  if (
    typeof claims.email !== "string" ||
    claims.email.toLowerCase() !== config.serviceAccountEmail.toLowerCase()
  ) {
    return { ok: false, reason: "wrong_service_account" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Notification decoding
// ---------------------------------------------------------------------------

const pushEnvelopeSchema = z.object({
  message: z.object({ data: z.string().min(1) }).passthrough(),
});

const gmailNotificationSchema = z.object({
  emailAddress: z.string().email(),
  historyId: z.union([z.string().min(1), z.number()]).transform(String),
});

export type GmailNotification = z.infer<typeof gmailNotificationSchema>;

export function decodeGmailNotification(rawBody: string): GmailNotification | null {
  try {
    const envelope = pushEnvelopeSchema.safeParse(JSON.parse(rawBody));
    if (!envelope.success) return null;
    const json = Buffer.from(envelope.data.message.data, "base64").toString("utf8");
    const notification = gmailNotificationSchema.safeParse(JSON.parse(json));
    return notification.success ? notification.data : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Webhook handler
// ---------------------------------------------------------------------------

export interface PushConnection {
  orgId: string;
  connectionId: string;
}

export interface GmailPushDeps {
  env: GmailPushEnv;
  verify: PubSubTokenVerifier;
  /** Healthy, non-replay Gmail connections for a mailbox, each with its own org. */
  findConnections(emailAddress: string): Promise<PushConnection[]>;
  /** Must be the same sync path the poller runs. */
  syncConnection(connection: PushConnection): Promise<SyncResult | { ok: false; reason: string }>;
}

export interface PushResponse {
  status: number;
  body: Record<string, unknown>;
}

export async function handleGmailPushWebhook(
  rawBody: string,
  authorization: string | null,
  deps: GmailPushDeps,
): Promise<PushResponse> {
  // Replay never contacts Google, not even for signing certs.
  if (deps.env.APP_ENV === "replay") {
    return { status: 200, body: { ok: true, ignored: "replay" } };
  }
  const config = gmailPushVerificationConfig(deps.env);
  if (!config) return { status: 503, body: { ok: false, code: "push_not_configured" } };

  const auth = await verifyPubSubPushAuth(authorization, config, deps.verify);
  if (!auth.ok) {
    console.warn("gmail push rejected", { reason: auth.reason });
    return { status: 401, body: { ok: false, code: "unauthorized" } };
  }

  const notification = decodeGmailNotification(rawBody);
  if (!notification) {
    // Authenticated but unusable: ack so Pub/Sub does not redeliver a poison message.
    return { status: 200, body: { ok: false, code: "invalid_notification" } };
  }

  const connections = await deps.findConnections(notification.emailAddress);
  let synced = 0;
  let failed = 0;
  for (const connection of connections) {
    try {
      const result = await deps.syncConnection(connection);
      if (result.ok) synced += 1;
    } catch (err) {
      failed += 1;
      console.error("gmail push sync failed", {
        connectionId: connection.connectionId,
        ...safeErrorLogFields(err),
      });
    }
  }
  // A thrown sync (store failure) leaves the cursor untouched and is idempotent,
  // so a 5xx lets Pub/Sub redeliver. Provider failures are ack'd: the sync already
  // recorded the connection status and the poll retries.
  if (failed > 0) {
    return { status: 500, body: { ok: false, code: "sync_failed", synced, failed } };
  }
  return { status: 200, body: { ok: true, connections: connections.length, synced } };
}

// ---------------------------------------------------------------------------
// Watch registration and renewal scheduling
// ---------------------------------------------------------------------------

const watchStateRowSchema = z
  .object({
    org_id: z.string().min(1),
    connection_id: z.string().min(1),
    environment_mode: z.string(),
    external_account_id: z.string().nullable(),
    watch_topic: z.string().nullable(),
    watch_expires_at: z.string().nullable(),
  })
  .transform((row) => ({
    orgId: row.org_id,
    connectionId: row.connection_id,
    environmentMode: row.environment_mode,
    externalAccountId: row.external_account_id,
    watchTopic: row.watch_topic,
    watchExpiresAt: row.watch_expires_at ? new Date(row.watch_expires_at) : null,
  }));

export type GmailWatchState = z.output<typeof watchStateRowSchema>;

export function parseGmailWatchStates(rows: unknown): GmailWatchState[] {
  return z.array(watchStateRowSchema).parse(rows);
}

export function watchNeedsRegistration(
  state: GmailWatchState,
  opts: { topic: string; now: Date; renewBeforeMs?: number },
): boolean {
  if (state.environmentMode === "replay") return false;
  if (!state.watchTopic || state.watchTopic !== opts.topic) return true;
  const expires = state.watchExpiresAt?.getTime();
  if (expires === undefined || Number.isNaN(expires)) return true;
  return expires - opts.now.getTime() <= (opts.renewBeforeMs ?? GMAIL_WATCH_RENEW_BEFORE_MS);
}

export function selectWatchesDue(
  states: GmailWatchState[],
  opts: { topic: string; now: Date; renewBeforeMs?: number },
): GmailWatchState[] {
  return states.filter((state) => watchNeedsRegistration(state, opts));
}

export type WatchRegistration =
  | { ok: true; expiresAt: Date }
  | { ok: false; reason: "unsupported" | "invalid_response" | "provider_error"; kind?: string };

export async function registerGmailWatch(args: {
  api: GmailApi;
  topic: string;
  now: Date;
  record(entry: { topic: string; expiresAt: Date }): Promise<void>;
}): Promise<WatchRegistration> {
  const { api, topic, now, record } = args;
  if (!api.watch) return { ok: false, reason: "unsupported" };
  let watched: { historyId: string; expiration: Date };
  try {
    watched = await api.watch({ topicName: topic });
  } catch (err) {
    const kind = classifyGmailError(err);
    console.error("gmail watch registration failed", { kind, ...safeErrorLogFields(err) });
    return { ok: false, reason: "provider_error", kind };
  }
  if (
    Number.isNaN(watched.expiration.getTime()) ||
    watched.expiration.getTime() <= now.getTime()
  ) {
    return { ok: false, reason: "invalid_response" };
  }
  await record({ topic, expiresAt: watched.expiration });
  return { ok: true, expiresAt: watched.expiration };
}
