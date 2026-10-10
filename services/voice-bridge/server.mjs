import Fastify from "fastify";
import formbody from "@fastify/formbody";
import websocket from "@fastify/websocket";
import WebSocket from "ws";
import {
  TERMINAL_CALL_STATUSES,
  buildStatusEvent,
  buildTwiML,
  constantTimeStringEqual,
  conversationMetadata,
  createSession,
  hangupTwiML,
  hasSupportedAudioFormats,
  isDestinationAllowed,
  parseAllowedTo,
  shouldSendStatus,
  signalWireMediaToElevenLabs,
  signPayload,
  translateAgentMessage,
  validateCallRequest,
  validateStartEvent,
  verifySignature,
} from "./lib.mjs";

const DEFAULT_PORT = 8080;
const MAX_CALL_MS = 330_000;
const SESSION_GRACE_MS = 60_000;
const SAFE_AUDIO_FORMATS = new Set(["ulaw_8000", "pcm_16000"]);

function parseHttpsUrl(name, value) {
  if (!value) throw new Error(`Missing or invalid ${name}`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Missing or invalid ${name}`);
  }
  if (parsed.protocol !== "https:") throw new Error(`Missing or invalid ${name}`);
  return value.replace(/\/+$/, "");
}

function required(env, name) {
  if (!env[name]) throw new Error(`Missing or invalid ${name}`);
  return env[name];
}

export function loadConfig(env = process.env) {
  const spaceUrl = required(env, "SIGNALWIRE_SPACE_URL").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!spaceUrl || spaceUrl.includes("/")) throw new Error("Missing or invalid SIGNALWIRE_SPACE_URL");
  const port = Number(env.PORT || env.BRIDGE_PORT || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Missing or invalid PORT");
  const phone = required(env, "SIGNALWIRE_PHONE_NUMBER");
  if (!/^\+[1-9][0-9]{7,14}$/.test(phone)) throw new Error("Missing or invalid SIGNALWIRE_PHONE_NUMBER");
  const secret = required(env, "VOICE_BRIDGE_SECRET");
  if (secret.length < 32) throw new Error("Missing or invalid VOICE_BRIDGE_SECRET");
  return {
    apiKey: required(env, "ELEVENLABS_API_KEY"),
    agentId: required(env, "ELEVENLABS_AGENT_ID"),
    signalwireSpace: spaceUrl,
    signalwireProjectId: required(env, "SIGNALWIRE_PROJECT_ID"),
    signalwireApiToken: required(env, "SIGNALWIRE_API_TOKEN"),
    signalwirePhoneNumber: phone,
    publicUrl: parseHttpsUrl("PUBLIC_URL", env.PUBLIC_URL),
    bridgeSecret: secret,
    conduitUrl: parseHttpsUrl("CONDUIT_URL", env.CONDUIT_URL),
    allowedTo: parseAllowedTo(env.BRIDGE_ALLOWED_TO),
    port,
  };
}

function providerError(statusCode, signalwireHttpStatus = statusCode) {
  const error = new Error("SignalWire request failed");
  error.statusCode = statusCode;
  error.signalwireHttpStatus = signalwireHttpStatus;
  return error;
}

function safeCallSid(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
}

function safeCloseReason(session, value, secrets = []) {
  let reason = Buffer.isBuffer(value) ? value.toString("utf8") : String(value ?? "");
  for (const sensitive of [
    ...Object.values(session?.dynamicVariables ?? {}),
    session?.mediaKey,
    ...secrets,
  ]) {
    const text = sensitive == null ? "" : String(sensitive);
    if (text) reason = reason.replaceAll(text, "[redacted]");
  }
  return reason
    .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, "[url]")
    .replace(/\+[1-9][0-9]{7,14}/g, "[phone]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]")
    .slice(0, 100);
}

export function createBridge(config, deps = {}) {
  const app = Fastify({ logger: false });
  const sessions = new Map();
  const sessionsByAction = new Map();
  const inFlight = new Map();
  const logger = deps.log ?? ((line) => console.log(line));
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const WebSocketImpl = deps.WebSocket ?? WebSocket;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => Date.now());
  const sessionGraceMs = deps.sessionGraceMs ?? SESSION_GRACE_MS;
  const maxCallMs = deps.maxCallMs ?? MAX_CALL_MS;
  let sweepTimer;

  function logEvent(session, event, fields = {}, context = {}) {
    logger(JSON.stringify({
      event,
      session: (session?.id ?? context.sessionId ?? "").slice(0, 8) || null,
      call_sid: safeCallSid(session?.callSid ?? context.callSid),
      t_ms: session ? Math.max(0, now() - session.createdAtMs) : null,
      ...fields,
    }));
  }

  function logCleanup(session) {
    if (session.cleanupLogged) return;
    session.cleanupLogged = true;
    logEvent(session, "session_cleanup", {
      ended_first: session.endedFirst ?? "unknown",
      carrier_audio_chunks: session.carrierAudioChunks,
      agent_audio_chunks: session.agentAudioChunks,
      interruption_count: session.interruptionCount,
    });
  }

  async function signalwire(path, form) {
    const response = await fetchImpl(`https://${config.signalwireSpace}${path}`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${config.signalwireProjectId}:${config.signalwireApiToken}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    if (!response.ok) throw providerError(response.status, response.status);
    try {
      return { status: response.status, data: JSON.parse(text) };
    } catch {
      throw providerError(502, response.status);
    }
  }

  async function hangup(session, reason) {
    if (!session.callSid || session.hangupAttempted) return null;
    session.hangupAttempted = true;
    let status = null;
    try {
      const response = await signalwire(
        `/api/laml/2010-04-01/Accounts/${encodeURIComponent(config.signalwireProjectId)}/Calls/${encodeURIComponent(session.callSid)}.json`,
        { Status: "completed" },
      );
      status = response.status;
    } catch (error) {
      // The carrier callback remains the source of truth if hangup is ambiguous.
      status = Number.isFinite(error?.signalwireHttpStatus)
        ? error.signalwireHttpStatus
        : null;
    }
    logEvent(session, "hangup_requested", { reason, rest_status: status });
    return status;
  }

  function scheduleDelete(session) {
    if (session.deleteTimer) return;
    session.deleteTimer = setTimeout(() => {
      logCleanup(session);
      sessions.delete(session.id);
      sessionsByAction.delete(session.actionId);
    }, sessionGraceMs);
    session.deleteTimer.unref?.();
  }

  async function sendStatus(session, callStatus, fields) {
    if (!shouldSendStatus({ conversationId: session.conversationId, callStatus })) {
      logEvent(session, "status_forward", { result: "skipped", http_status: null });
      return;
    }
    const rawBody = JSON.stringify(buildStatusEvent(session, callStatus, fields));
    const signature = signPayload(rawBody, config.bridgeSecret);
    const url = `${config.conduitUrl}/api/webhooks/voice-bridge`;
    let status = null;
    let sent = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-conduit-signature": signature },
          body: rawBody,
          signal: AbortSignal.timeout(10_000),
        });
        status = response.status;
        if (response.ok) {
          sent = true;
          break;
        }
      } catch {
        // Retry with the same signed bytes and event key.
        status = null;
      }
      if (attempt < 2) await sleep(100 * 2 ** attempt);
    }
    logEvent(session, "status_forward", { result: sent ? "sent" : "failed", http_status: status });
  }

  async function dial(session, to) {
    try {
      const response = await signalwire(
        `/api/laml/2010-04-01/Accounts/${encodeURIComponent(config.signalwireProjectId)}/Calls.json`,
        {
          From: config.signalwirePhoneNumber,
          To: to,
          Url: `${config.publicUrl}/twiml/${session.id}?k=${session.mediaKey}`,
          Method: "POST",
          StatusCallback: `${config.publicUrl}/status/${session.id}?k=${session.mediaKey}`,
          StatusCallbackMethod: "POST",
          StatusCallbackEvent: "completed",
          Timeout: "45",
        },
      );
      const callSid = response.data?.sid ?? response.data?.call_sid;
      if (typeof callSid !== "string" || !callSid) throw providerError(502, response.status);
      session.callSid = callSid;
      session.state = "active";
      logEvent(session, "call_created", { signalwire_http_status: response.status, result: "created" });
      return { status: 200, body: { call_sid: callSid } };
    } catch (error) {
      const code = Number(error?.statusCode);
      logEvent(session, "call_created", {
        signalwire_http_status: Number.isFinite(error?.signalwireHttpStatus)
          ? error.signalwireHttpStatus
          : null,
        result: code >= 400 && code < 500 ? "rejected" : "ambiguous",
      });
      if (code >= 400 && code < 500) {
        session.state = "rejected";
        return { status: 422, body: { error: "carrier_rejected" } };
      }
      session.state = "ambiguous";
      return { status: 502, body: { error: "carrier_result_ambiguous" } };
    }
  }

  async function handleCall(request) {
    const rawBody = typeof request.body === "string" ? request.body : "";
    const signature = request.headers["x-conduit-signature"];
    const check = verifySignature(rawBody, signature, config.bridgeSecret, now());
    if (!check.ok) return { status: 401, body: { error: check.reason } };
    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return { status: 400, body: { error: "invalid_json" } };
    }
    const parsed = validateCallRequest(body, rawBody);
    if (!parsed.ok) return { status: 400, body: { error: parsed.code } };
    if (!isDestinationAllowed(parsed.value.to, config.allowedTo)) return { status: 403, body: { error: "destination_not_allowed" } };

    const existing = sessionsByAction.get(parsed.value.action_id);
    if (existing) {
      if (existing.state === "ambiguous") return { status: 409, body: { error: "call_result_ambiguous" } };
      if (existing.state === "rejected") return { status: 422, body: { error: "carrier_rejected" } };
      if (existing.callSid) return { status: 200, body: { call_sid: existing.callSid } };
      const pending = inFlight.get(existing.actionId);
      if (pending) return pending;
    }

    const session = existing ?? createSession({
      actionId: parsed.value.action_id,
      dynamicVariables: parsed.value.dynamic_variables,
      nowMs: now(),
    });
    sessions.set(session.id, session);
    sessionsByAction.set(session.actionId, session);
    const pending = dial(session, parsed.value.to);
    inFlight.set(session.actionId, pending);
    try {
      return await pending;
    } finally {
      inFlight.delete(session.actionId);
    }
  }

  async function handleStatus(request, reply) {
    const session = sessions.get(request.params.id);
    if (!session || !session.mediaKey || !request.query?.k || !constantTime(request.query.k, session.mediaKey)) {
      return reply.code(204).send();
    }
    const callbackCallSid = request.body?.CallSid;
    if (!session.callSid && typeof callbackCallSid === "string") session.callSid = callbackCallSid;
    if (!session.callSid || (callbackCallSid && callbackCallSid !== session.callSid)) return reply.code(204).send();
    const requestedStatus = String(request.body?.CallStatus ?? "").toLowerCase();
    const status = TERMINAL_CALL_STATUSES.has(requestedStatus) ? requestedStatus : "unknown";
    const rawSipResponseCode = request.body?.SipResponseCode;
    const sipResponseCode =
      rawSipResponseCode !== undefined &&
      rawSipResponseCode !== "" &&
      Number.isFinite(Number(rawSipResponseCode))
        ? Number(rawSipResponseCode) >= 100 && Number(rawSipResponseCode) <= 699
          ? Number(rawSipResponseCode)
          : null
        : null;
    logEvent(session, "status_callback", {
      call_status: status,
      sip_response_code: sipResponseCode,
    });
    if (status !== "unknown") {
      session.state = "terminal";
      session.endedFirst ??= "carrier";
      await sendStatus(session, status, {
        sipResponseCode: sipResponseCode ?? undefined,
        reason: request.body?.ErrorMessage || request.body?.CallStatus,
      });
      scheduleDelete(session);
    }
    return reply.code(204).send();
  }

  function constantTime(left, right) {
    return constantTimeStringEqual(left, right);
  }

  async function handleMedia(carrier) {
    let session;
    let provider;
    let streamSid;
    let closed = false;
    let hardCap;
    const queue = [];
    const startedAt = now();
    let carrierCloseLogged = false;

    logEvent(null, "media_connected");

    const logCarrierClose = (code) => {
      if (carrierCloseLogged) return;
      carrierCloseLogged = true;
      logEvent(session, "carrier_ws_close", { code: Number.isInteger(code) ? code : null });
    };

    const finish = async ({ hangupCarrier = false, reason = "agent_end", endedBy } = {}) => {
      if (closed) return;
      closed = true;
      clearTimeout(hardCap);
      if (session && !session.endedFirst) {
        session.endedFirst = endedBy ?? (hangupCarrier ? "agent" : "carrier");
      }
      if (provider && provider.readyState === WebSocketImpl.OPEN) provider.close();
      if (hangupCarrier && session) await hangup(session, reason);
      if (carrier.readyState === WebSocketImpl.OPEN) {
        logCarrierClose(1000);
        carrier.close();
      }
      if (session) {
        session.streamActive = false;
        session.state = "terminal";
        scheduleDelete(session);
      }
    };

    const openProvider = async () => {
      const response = await fetchImpl(`https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(config.agentId)}`, {
        headers: { "xi-api-key": config.apiKey },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error("signed URL unavailable");
      const data = await response.json();
      if (!data?.signed_url) throw new Error("signed URL unavailable");
      provider = new WebSocketImpl(data.signed_url);
      provider.on("open", () => {
        logEvent(session, "agent_ws_open");
        provider.send(JSON.stringify({ type: "conversation_initiation_client_data", dynamic_variables: session.dynamicVariables }));
        while (queue.length && provider.readyState === WebSocketImpl.OPEN) provider.send(queue.shift());
      });
      provider.on("message", (raw) => {
        let message;
        try {
          message = JSON.parse(raw.toString());
        } catch {
          return;
        }
        const metadata = conversationMetadata(message);
        if (metadata) {
          if (metadata.conversationId) session.conversationId = metadata.conversationId;
          const conversationId =
            typeof metadata.conversationId === "string" &&
            /^conv_[A-Za-z0-9_-]{1,96}$/.test(metadata.conversationId)
              ? metadata.conversationId
              : null;
          logEvent(session, "agent_metadata", {
            conversation_id: conversationId,
            agent_output_audio_format: SAFE_AUDIO_FORMATS.has(metadata.agentOutputAudioFormat)
              ? metadata.agentOutputAudioFormat
              : null,
            user_input_audio_format: SAFE_AUDIO_FORMATS.has(metadata.userInputAudioFormat)
              ? metadata.userInputAudioFormat
              : null,
          });
          if (!hasSupportedAudioFormats(metadata)) {
            void finish({ hangupCarrier: true, reason: "format", endedBy: "format" });
          }
          return;
        }
        const translated = translateAgentMessage(message, streamSid);
        if (translated?.toAgent && provider.readyState === WebSocketImpl.OPEN) {
          provider.send(JSON.stringify(translated.toAgent));
        }
        if (translated?.toCarrier && carrier.readyState === WebSocketImpl.OPEN) {
          if (message.type === "audio") {
            session.agentAudioChunks += 1;
            if (session.agentAudioChunks === 1) logEvent(session, "first_agent_audio");
          } else if (message.type === "interruption") {
            session.interruptionCount += 1;
            logEvent(session, "agent_interruption", { count: session.interruptionCount });
          }
          carrier.send(JSON.stringify(translated.toCarrier));
        }
      });
      provider.on("close", (code, reason) => {
        logEvent(session, "agent_ws_close", {
          code: Number.isInteger(code) ? code : null,
          reason: safeCloseReason(session, reason, [
            config.bridgeSecret,
            config.apiKey,
            config.signalwireApiToken,
            config.signalwirePhoneNumber,
          ]),
        });
        void finish({ hangupCarrier: true, reason: "agent_end", endedBy: "agent" });
      });
      provider.on("error", () => void finish({ hangupCarrier: true, reason: "error", endedBy: "error" }));
    };

    carrier.on("message", async (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message.event === "start") {
        const start = message.start ?? {};
        const sessionId = start.customParameters?.sessionId;
        const candidate = sessions.get(sessionId);
        const result = validateStartEvent(candidate, start.customParameters, start.callSid, now());
        if (!result.ok) {
          logEvent(candidate, "stream_rejected", { code: result.code }, {
            sessionId: candidate ? null : /^[0-9a-f-]{36}$/i.test(sessionId ?? "") ? sessionId : null,
            callSid: candidate ? null : safeCallSid(start.callSid),
          });
          logCarrierClose(1000);
          return carrier.close();
        }
        session = candidate;
        streamSid = start.streamSid;
        session.streamActive = true;
        session.state = "streaming";
        const mediaFormat = start.mediaFormat ?? {};
        logEvent(session, "stream_start", {
          call_sid_match: start.callSid === session.callSid,
          media_format: {
            encoding:
              mediaFormat.encoding === "audio/x-mulaw" || mediaFormat.encoding === "PCMU"
                ? mediaFormat.encoding
                : null,
            sample_rate: [8_000, 16_000, 22_050, 24_000, 44_100, 48_000].includes(mediaFormat.sampleRate)
              ? mediaFormat.sampleRate
              : null,
            channels: mediaFormat.channels === 1 || mediaFormat.channels === 2
              ? mediaFormat.channels
              : null,
          },
        });
        hardCap = setTimeout(
          () => void finish({ hangupCarrier: true, reason: "cap", endedBy: "cap" }),
          maxCallMs,
        );
        hardCap.unref?.();
        try {
          await openProvider();
        } catch {
          await finish({ hangupCarrier: true, reason: "error", endedBy: "error" });
        }
        return;
      }
      if (!session) return;
      if (message.event === "media") {
        const translated = signalWireMediaToElevenLabs(message);
        if (!translated) return;
        session.carrierAudioChunks += 1;
        if (session.carrierAudioChunks === 1) logEvent(session, "first_carrier_audio");
        const encoded = JSON.stringify(translated);
        if (provider?.readyState === WebSocketImpl.OPEN) provider.send(encoded);
        else if (now() - startedAt <= 5_000) {
          queue.push(encoded);
          while (queue.length > 250) queue.shift();
        }
      } else if (message.event === "stop") {
        logEvent(session, "carrier_stop");
        await finish({ endedBy: "carrier" });
      }
    });
    carrier.on("close", (code) => {
      logCarrierClose(code);
      void finish({ endedBy: "carrier" });
    });
    carrier.on("error", () => void finish({ hangupCarrier: true, reason: "error", endedBy: "error" }));
  }

  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => done(null, body));
  app.register(formbody);
  app.register(websocket);
  app.register(async function bridgeRoutes(routes) {
    routes.get("/health", async () => ({ ok: true }));
    routes.post("/calls", async (request, reply) => {
      const result = await handleCall(request);
      return reply.code(result.status).send(result.body);
    });
    routes.post("/twiml/:id", async (request, reply) => {
      const session = sessions.get(request.params.id);
      let reason = null;
      if (!session) reason = "unknown_session";
      else if (session.expiresAt <= now()) reason = "session_expired";
      else if (!request.query?.k) reason = "missing_capability";
      else if (!constantTime(request.query.k, session.mediaKey)) reason = "invalid_capability";
      if (reason) {
        logEvent(session, "twiml_rejected", { reason_code: reason }, {
          sessionId:
            session || !/^[0-9a-f-]{36}$/i.test(request.params.id)
              ? null
              : request.params.id,
        });
        return reply.code(404).type("text/xml").send(hangupTwiML());
      }
      logEvent(session, "twiml_served");
      return reply.type("text/xml").send(buildTwiML(config.publicUrl, session));
    });
    routes.get("/media", { websocket: true }, (socket) => void handleMedia(socket));
    routes.post("/status/:id", handleStatus);
    routes.addHook("onReady", async () => {
      sweepTimer = setInterval(() => {
        for (const session of sessions.values()) {
          if (session.expiresAt <= now() && !session.streamActive) {
            session.endedFirst ??= "expiry";
            logCleanup(session);
            sessions.delete(session.id);
            sessionsByAction.delete(session.actionId);
          }
        }
      }, 60_000);
      sweepTimer.unref?.();
    });
    routes.addHook("onClose", async () => clearInterval(sweepTimer));
  });
  return { app, sessions };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const bridge = createBridge(config);
  await bridge.app.listen({ port: config.port, host: "0.0.0.0" });
}
