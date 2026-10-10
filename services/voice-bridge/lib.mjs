import { createHmac, createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export const SIGNATURE_MAX_AGE_SECONDS = 300;
export const SESSION_TTL_MS = 15 * 60 * 1000;
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_DYNAMIC_KEYS = 64;
export const MAX_DYNAMIC_VALUE_LENGTH = 4000;
export const TERMINAL_CALL_STATUSES = new Set(["no-answer", "busy", "failed", "canceled", "completed"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const E164 = /^\+[1-9][0-9]{7,14}$/;

export function signPayload(rawBody, secret, timestampSeconds = Math.floor(Date.now() / 1000)) {
  const digest = createHmac("sha256", secret).update(`${timestampSeconds}.${rawBody}`, "utf8").digest("hex");
  return `t=${timestampSeconds},v0=${digest}`;
}

export function verifySignature(rawBody, header, secret, nowMs = Date.now(), maxAgeSeconds = SIGNATURE_MAX_AGE_SECONDS) {
  if (typeof header !== "string") return { ok: false, reason: "missing_signature" };
  const match = /^t=([0-9]+),v0=([0-9a-f]{64})$/.exec(header);
  if (!match) return { ok: false, reason: "malformed_signature" };
  const timestamp = Number(match[1]);
  const age = nowMs / 1000 - timestamp;
  if (!Number.isFinite(timestamp) || Math.abs(age) > maxAgeSeconds) return { ok: false, reason: "stale_signature" };
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
  const actualBytes = Buffer.from(match[2], "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    return { ok: false, reason: "invalid_signature" };
  }
  return { ok: true, timestamp };
}

export function validateCallRequest(body, rawBody = JSON.stringify(body)) {
  if (typeof rawBody !== "string" || Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    return { ok: false, code: "body_too_large" };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, code: "invalid_body" };
  const allowed = new Set(["action_id", "to", "dynamic_variables"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) return { ok: false, code: "unknown_field" };
  if (typeof body.action_id !== "string" || !UUID.test(body.action_id)) return { ok: false, code: "invalid_action_id" };
  if (typeof body.to !== "string" || !E164.test(body.to)) return { ok: false, code: "invalid_destination" };
  const variables = body.dynamic_variables;
  if (!variables || typeof variables !== "object" || Array.isArray(variables)) {
    return { ok: false, code: "invalid_dynamic_variables" };
  }
  const keys = Object.keys(variables);
  if (keys.length > MAX_DYNAMIC_KEYS) return { ok: false, code: "too_many_dynamic_variables" };
  for (const key of keys) {
    const value = variables[key];
    if (
      !(
        typeof value === "string" ||
        (typeof value === "number" && Number.isFinite(value)) ||
        typeof value === "boolean"
      )
    ) {
      return { ok: false, code: "invalid_dynamic_variable" };
    }
    if (typeof value === "string" && value.length > MAX_DYNAMIC_VALUE_LENGTH) {
      return { ok: false, code: "dynamic_variable_too_long" };
    }
  }
  return {
    ok: true,
    value: {
      action_id: body.action_id,
      to: body.to,
      dynamic_variables: { ...variables },
    },
  };
}

export function parseAllowedTo(value) {
  if (!value?.trim()) return null;
  const entries = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (entries.some((item) => !E164.test(item))) throw new Error("Invalid BRIDGE_ALLOWED_TO");
  return new Set(entries);
}

export function isDestinationAllowed(to, allowlist) {
  return !allowlist || allowlist.has(to);
}

export function createSession({ actionId, dynamicVariables, nowMs = Date.now() }) {
  return {
    id: randomUUID(),
    mediaKey: randomBytes(32).toString("base64url"),
    actionId,
    dynamicVariables,
    createdAtMs: nowMs,
    expiresAt: nowMs + SESSION_TTL_MS,
    state: "dialing",
    callSid: null,
    conversationId: null,
    streamActive: false,
    terminal: false,
    carrierAudioChunks: 0,
    agentAudioChunks: 0,
    interruptionCount: 0,
    endedFirst: null,
    cleanupLogged: false,
  };
}

export function constantTimeStringEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function validateStartEvent(session, customParameters, callSid, nowMs = Date.now()) {
  if (!session || session.expiresAt <= nowMs) return { ok: false, code: "unknown_session" };
  if (
    !customParameters ||
    customParameters.sessionId !== session.id ||
    !constantTimeStringEqual(customParameters.key, session.mediaKey)
  ) {
    return { ok: false, code: "invalid_capability" };
  }
  if (!session.callSid || callSid !== session.callSid) return { ok: false, code: "call_sid_mismatch" };
  if (session.streamActive) return { ok: false, code: "stream_already_active" };
  return { ok: true };
}

export function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function buildTwiML(publicUrl, session) {
  const host = new URL(publicUrl).host;
  return `<Response><Connect><Stream url="wss://${xmlEscape(host)}/media"><Parameter name="sessionId" value="${xmlEscape(session.id)}"/><Parameter name="key" value="${xmlEscape(session.mediaKey)}"/></Stream></Connect></Response>`;
}

export function hangupTwiML() {
  return "<Response><Hangup/></Response>";
}

export function signalWireMediaToElevenLabs(message) {
  if (message?.event !== "media" || typeof message.media?.payload !== "string") return null;
  return { user_audio_chunk: message.media.payload };
}

export function translateAgentMessage(message, streamSid) {
  if (message?.type === "audio" && typeof streamSid === "string" && streamSid) {
    const payload = message.audio_event?.audio_base_64 ?? message.audio?.chunk;
    if (typeof payload === "string") {
      return { toCarrier: { event: "media", streamSid, media: { payload } } };
    }
  }
  if (message?.type === "interruption" && typeof streamSid === "string" && streamSid) {
    return { toCarrier: { event: "clear", streamSid } };
  }
  if (message?.type === "ping") {
    const eventId = message.ping_event?.event_id;
    if (typeof eventId === "string" || typeof eventId === "number") {
      return { toAgent: { type: "pong", event_id: eventId } };
    }
  }
  return null;
}

export function conversationMetadata(message) {
  if (message?.type !== "conversation_initiation_metadata") return null;
  const event = message.conversation_initiation_metadata_event ?? message;
  return {
    conversationId: event.conversation_id ?? null,
    userInputAudioFormat: event.user_input_audio_format ?? null,
    agentOutputAudioFormat: event.agent_output_audio_format ?? null,
  };
}

export function hasSupportedAudioFormats(metadata) {
  return (
    metadata?.userInputAudioFormat === "ulaw_8000" &&
    metadata?.agentOutputAudioFormat === "ulaw_8000"
  );
}

export function shouldSendStatus({ conversationId, callStatus }) {
  return !conversationId && TERMINAL_CALL_STATUSES.has(callStatus);
}

export function statusFailureReason(callStatus) {
  if (callStatus === "no-answer") return "no-answer";
  if (callStatus === "busy") return "busy";
  return "initiation_failed";
}

export function buildStatusEvent(session, callStatus, { sipResponseCode, reason, occurredAt } = {}) {
  return {
    type: "call_status",
    action_id: session.actionId,
    call_sid: session.callSid,
    call_status: callStatus,
    ...(typeof sipResponseCode === "number" ? { sip_response_code: sipResponseCode } : {}),
    ...(reason ? { reason: String(reason).slice(0, 500) } : {}),
    occurred_at: occurredAt ?? new Date().toISOString(),
  };
}

export function payloadHash(rawBody) {
  return createHash("sha256").update(rawBody, "utf8").digest("hex");
}
