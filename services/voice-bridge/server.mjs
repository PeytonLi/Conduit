import Fastify from "fastify";
import formbody from "@fastify/formbody";
import websocket from "@fastify/websocket";
import WebSocket from "ws";
import {
  buildStatusEvent,
  buildTwiML,
  constantTimeStringEqual,
  conversationMetadata,
  createSession,
  elevenLabsToSignalWire,
  hangupTwiML,
  hasSupportedAudioFormats,
  isDestinationAllowed,
  parseAllowedTo,
  shouldSendStatus,
  signalWireMediaToElevenLabs,
  signPayload,
  validateCallRequest,
  validateStartEvent,
  verifySignature,
} from "./lib.mjs";

const DEFAULT_PORT = 8080;
const MAX_CALL_MS = 330_000;
const SESSION_GRACE_MS = 60_000;

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

function providerError(statusCode) {
  const error = new Error("SignalWire request failed");
  error.statusCode = statusCode;
  return error;
}

export function createBridge(config, deps = {}) {
  const app = Fastify({ logger: false });
  const sessions = new Map();
  const sessionsByAction = new Map();
  const inFlight = new Map();
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const WebSocketImpl = deps.WebSocket ?? WebSocket;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => Date.now());
  let sweepTimer;

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
    if (!response.ok) throw providerError(response.status);
    try {
      return JSON.parse(text);
    } catch {
      throw providerError(502);
    }
  }

  async function hangup(session) {
    if (!session.callSid || session.hangupAttempted) return;
    session.hangupAttempted = true;
    try {
      await signalwire(
        `/api/laml/2010-04-01/Accounts/${encodeURIComponent(config.signalwireProjectId)}/Calls/${encodeURIComponent(session.callSid)}.json`,
        { Status: "completed" },
      );
    } catch {
      // The carrier callback remains the source of truth if hangup is ambiguous.
    }
  }

  function scheduleDelete(session) {
    if (session.deleteTimer) return;
    session.deleteTimer = setTimeout(() => {
      sessions.delete(session.id);
      sessionsByAction.delete(session.actionId);
    }, SESSION_GRACE_MS);
    session.deleteTimer.unref?.();
  }

  async function sendStatus(session, callStatus, fields) {
    if (!shouldSendStatus({ conversationId: session.conversationId, callStatus })) return;
    const rawBody = JSON.stringify(buildStatusEvent(session, callStatus, fields));
    const signature = signPayload(rawBody, config.bridgeSecret);
    const url = `${config.conduitUrl}/api/webhooks/voice-bridge`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-conduit-signature": signature },
          body: rawBody,
          signal: AbortSignal.timeout(10_000),
        });
        if (response.ok) return;
      } catch {
        // Retry with the same signed bytes and event key.
      }
      if (attempt < 2) await sleep(100 * 2 ** attempt);
    }
  }

  async function dial(session, to) {
    try {
      const result = await signalwire(
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
      const callSid = result?.sid ?? result?.call_sid;
      if (typeof callSid !== "string" || !callSid) throw providerError(502);
      session.callSid = callSid;
      session.state = "active";
      return { status: 200, body: { call_sid: callSid } };
    } catch (error) {
      const code = Number(error?.statusCode);
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
    const status = String(request.body?.CallStatus ?? "").toLowerCase();
    if (status && ["completed", "failed", "busy", "no-answer", "canceled"].includes(status)) {
      session.state = "terminal";
      await sendStatus(session, status, {
        sipResponseCode: Number.isFinite(Number(request.body?.SipResponseCode)) ? Number(request.body.SipResponseCode) : undefined,
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

    const finish = async ({ hangupCarrier = false } = {}) => {
      if (closed) return;
      closed = true;
      clearTimeout(hardCap);
      if (provider && provider.readyState === WebSocketImpl.OPEN) provider.close();
      if (hangupCarrier && session) await hangup(session);
      if (carrier.readyState === WebSocketImpl.OPEN) carrier.close();
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
          if (!hasSupportedAudioFormats(metadata)) void finish({ hangupCarrier: true });
          return;
        }
        const outgoing = elevenLabsToSignalWire(message, streamSid);
        if (outgoing && carrier.readyState === WebSocketImpl.OPEN) carrier.send(JSON.stringify(outgoing));
      });
      provider.on("close", () => void finish({ hangupCarrier: true }));
      provider.on("error", () => void finish({ hangupCarrier: true }));
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
        const result = validateStartEvent(session = sessions.get(start.customParameters?.sessionId), start.customParameters, start.callSid, now());
        if (!result.ok) return carrier.close();
        streamSid = start.streamSid;
        session.streamActive = true;
        session.state = "streaming";
        hardCap = setTimeout(() => void finish({ hangupCarrier: true }), MAX_CALL_MS);
        hardCap.unref?.();
        try {
          await openProvider();
        } catch {
          await finish({ hangupCarrier: true });
        }
        return;
      }
      if (!session) return;
      if (message.event === "media") {
        const translated = signalWireMediaToElevenLabs(message);
        if (!translated) return;
        const encoded = JSON.stringify(translated);
        if (provider?.readyState === WebSocketImpl.OPEN) provider.send(encoded);
        else if (now() - startedAt <= 5_000) {
          queue.push(encoded);
          while (queue.length > 250) queue.shift();
        }
      } else if (message.event === "stop") {
        await finish();
      }
    });
    carrier.on("close", () => void finish());
    carrier.on("error", () => void finish());
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
      if (!session || session.expiresAt <= now() || !request.query?.k || !constantTime(request.query.k, session.mediaKey)) {
        return reply.code(404).type("text/xml").send(hangupTwiML());
      }
      return reply.type("text/xml").send(buildTwiML(config.publicUrl, session));
    });
    routes.get("/media", { websocket: true }, (socket) => void handleMedia(socket));
    routes.post("/status/:id", handleStatus);
    routes.addHook("onReady", async () => {
      sweepTimer = setInterval(() => {
        for (const session of sessions.values()) {
          if (session.expiresAt <= now() && !session.streamActive) {
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
