import { createHash } from "node:crypto";
import { z } from "zod";
import type { VoiceStore } from "@/lib/db/voice-store";
import {
  normalizeInitiationFailure,
  normalizeTranscription,
  type CallToolSummary,
  type NormalizedCallOutcome,
} from "./outcomes";
import { verifyElevenLabsSignature } from "./signature";

export interface ElevenLabsWebhookDeps {
  store: VoiceStore;
  secret: string | undefined;
  now: () => Date;
}

export interface WebhookResponse {
  status: number;
  body: Record<string, unknown>;
}

const envelopeSchema = z.object({
  type: z.string(),
  event_timestamp: z.number().optional(),
  data: z.looseObject({ conversation_id: z.string().min(1).max(200) }),
});

type Loose = Record<string, unknown>;
const rec = (value: unknown): Loose => (value && typeof value === "object" && !Array.isArray(value) ? (value as Loose) : {});
const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NO_TOOLS: CallToolSummary = { offer_recorded: false, human_review_requested: false, end_call_logged: false };

function normalize(type: string, data: Loose, tools: CallToolSummary): NormalizedCallOutcome {
  const metadata = rec(data.metadata);
  if (type === "call_initiation_failure") {
    const body = rec(metadata.body);
    return normalizeInitiationFailure({
      failure_reason: str(data.failure_reason),
      sip_status_code: num(body.sip_status_code) ?? num(body.sip_status),
    });
  }
  const transcript = Array.isArray(data.transcript) ? data.transcript.map(rec) : [];
  const supplierTurns = transcript.filter((turn) => turn.role === "user" && str(turn.message)?.trim()).length;
  const voicemail = transcript.some((turn) =>
    (Array.isArray(turn.tool_calls) ? turn.tool_calls : []).some((call) => rec(call).tool_name === "voicemail_detection"),
  );
  return normalizeTranscription(
    {
      status: str(data.status),
      termination_reason: str(metadata.termination_reason),
      error_present: Boolean(metadata.error),
      duration_seconds: num(metadata.call_duration_secs),
      supplier_turns: supplierTurns,
      voicemail_detected: voicemail,
    },
    tools,
  );
}

/**
 * ElevenLabs post-call webhook. Signature is verified on the raw body first; the receipt is durably
 * stored (or quarantined) before any 2xx. Duplicates acknowledge the original receipt. Processing
 * never changes run control or approves anything; it records the call result and emits
 * supplier.call.finished via the outbox for the case workflow to handle under current control state.
 */
export async function handleElevenLabsWebhook(
  rawBody: string,
  signatureHeader: string | null,
  deps: ElevenLabsWebhookDeps,
): Promise<WebhookResponse> {
  if (!deps.secret) return { status: 503, body: { ok: false, code: "not_configured" } };
  const check = verifyElevenLabsSignature(rawBody, signatureHeader, deps.secret, deps.now().getTime());
  if (!check.ok) return { status: 401, body: { ok: false, code: check.reason } };

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { ok: false, code: "invalid_json" } };
  }
  const envelope = envelopeSchema.safeParse(json);
  if (!envelope.success) return { status: 400, body: { ok: false, code: "invalid_payload" } };
  const { type, data } = envelope.data;
  if (type === "post_call_audio") return { status: 200, body: { ok: true, status: "ignored_audio_not_retained" } };
  if (type !== "post_call_transcription" && type !== "call_initiation_failure") {
    return { status: 200, body: { ok: true, status: "ignored_event_type" } };
  }

  const conversationId = data.conversation_id;
  const variables = rec(rec(data.conversation_initiation_client_data).dynamic_variables);
  const hint = str(variables.conduit_action_id);
  const actionHint = hint && GUID.test(hint) ? hint : null;

  const link = await deps.store.callbackLink(conversationId, actionHint);
  const outcome = normalize(type, data, link ?? NO_TOOLS);
  const metadata = rec(data.metadata);
  const summary = str(rec(data.analysis).transcript_summary);

  const result = await deps.store.recordCallback({
    provider: "elevenlabs",
    external_event_key: `${type}:${conversationId}`,
    conversation_id: conversationId,
    event_type: type,
    payload_hash: createHash("sha256").update(rawBody, "utf8").digest("hex"),
    payload: json,
    received_at: deps.now().toISOString(),
    action_hint: actionHint,
    outcome,
    excerpt: summary ? `Supplier call summary (provider-generated, untrusted): ${summary.slice(0, 500)}` : null,
    provider_call_id: str(rec(metadata.phone_call).call_sid) ?? str(rec(metadata.body).call_sid),
    duration_seconds: outcome.detail.duration_seconds === null ? null : Math.round(outcome.detail.duration_seconds),
  });

  if (result.status === "duplicate") {
    return { status: 200, body: { ok: true, status: "duplicate", receipt_id: result.receipt_id } };
  }
  if (result.status === "quarantined") return { status: 200, body: { ok: true, status: "quarantined" } };
  return { status: 200, body: { ok: true, status: "recorded", receipt_id: result.receipt_id, outcome: outcome.outcome } };
}
