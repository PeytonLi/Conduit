import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createBridge } from "./server.mjs";
import { signPayload } from "./lib.mjs";

const config = {
  apiKey: "api-key",
  agentId: "agent",
  signalwireSpace: "space.signalwire.com",
  signalwireProjectId: "project",
  signalwireApiToken: "token",
  signalwirePhoneNumber: "+15555550100",
  publicUrl: "https://bridge.example.test",
  bridgeSecret: "12345678901234567890123456789012",
  conduitUrl: "https://conduit.example.test",
  allowedTo: null,
  port: 8080,
};

function fakeProviderType(onCreate) {
  return class FakeProvider extends EventEmitter {
    static OPEN = 1;

    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      onCreate(this);
    }

    open() {
      this.readyState = FakeProvider.OPEN;
      this.emit("open");
    }

    send(data) {
      this.sent.push(data);
    }

    receive(message) {
      this.emit("message", Buffer.from(JSON.stringify(message)));
    }

    close(code = 1000, reason = "") {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.emit("close", code, Buffer.from(reason));
    }
  };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

async function postCall(bridge, { actionId, to, dynamicVariables = {} }) {
  const body = JSON.stringify({
    action_id: actionId,
    to,
    dynamic_variables: dynamicVariables,
  });
  return bridge.app.inject({
    method: "POST",
    url: "/calls",
    payload: body,
    headers: {
      "content-type": "application/json",
      "x-conduit-signature": signPayload(body, config.bridgeSecret),
    },
  });
}

test("unauthenticated calls are rejected and duplicate action IDs do not dial twice", async () => {
  let dials = 0;
  const bridge = createBridge(config, {
    now: () => 1_000_000_000,
    log: () => {},
    fetch: async (_url, init) => {
      dials += 1;
      assert.equal(init.method, "POST");
      return new Response(JSON.stringify({ sid: "CA1" }), { status: 200 });
    },
  });
  await bridge.app.ready();
  const unauth = await bridge.app.inject({
    method: "POST",
    url: "/calls",
    payload: JSON.stringify({ action_id: "60000000-0000-4000-8000-000000000001", to: "+15555550101", dynamic_variables: {} }),
    headers: { "content-type": "application/json" },
  });
  assert.equal(unauth.statusCode, 401);

  const body = JSON.stringify({ action_id: "60000000-0000-4000-8000-000000000001", to: "+15555550101", dynamic_variables: {} });
  const headers = {
    "content-type": "application/json",
    "x-conduit-signature": signPayload(body, config.bridgeSecret, 1_000_000),
  };
  const first = await bridge.app.inject({ method: "POST", url: "/calls", payload: body, headers });
  const second = await bridge.app.inject({ method: "POST", url: "/calls", payload: body, headers });
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(JSON.parse(first.body).call_sid, "CA1");
  assert.equal(dials, 1);
  await bridge.app.close();
});

test("media WebSocket accepts a handshake and closes an invalid start", async () => {
  const logs = [];
  const bridge = createBridge(config, { log: (line) => logs.push(JSON.parse(line)) });
  await bridge.app.ready();
  try {
    const socket = await bridge.app.injectWS("/media");
    const closed = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("WebSocket did not close")), 5_000);
      socket.once("close", (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });
    socket.send(JSON.stringify({
      event: "start",
      start: {
        callSid: "CA-bogus",
        streamSid: "MZ-bogus",
        customParameters: {
          sessionId: "00000000-0000-4000-8000-000000000000",
          key: "invalid",
        },
      },
    }));
    assert.ok(Number.isInteger(await closed));
    assert.ok(logs.some((entry) => entry.event === "media_connected"));
    assert.ok(logs.some((entry) => entry.event === "stream_rejected" && entry.code === "unknown_session"));
  } finally {
    await bridge.app.close();
  }
});

test("carrier status retries the same signed callback bytes and always acknowledges the carrier", async () => {
  const callbacks = [];
  const logs = [];
  let signalwireCount = 0;
  const bridge = createBridge(config, {
    now: () => 1_000_000_000,
    log: (line) => logs.push(JSON.parse(line)),
    sleep: async () => {},
    fetch: async (url, init) => {
      if (String(url).includes("conduit.example.test")) {
        callbacks.push({ body: init.body, signature: init.headers["x-conduit-signature"] });
        return new Response("", { status: callbacks.length < 3 ? 500 : 200 });
      }
      signalwireCount += 1;
      return new Response(JSON.stringify({ sid: "CA2" }), { status: 200 });
    },
  });
  await bridge.app.ready();
  const body = JSON.stringify({ action_id: "60000000-0000-4000-8000-000000000002", to: "+15555550102", dynamic_variables: {} });
  const headers = {
    "content-type": "application/json",
    "x-conduit-signature": signPayload(body, config.bridgeSecret, 1_000_000),
  };
  await bridge.app.inject({ method: "POST", url: "/calls", payload: body, headers });
  const session = [...bridge.sessions.values()][0];
  const result = await bridge.app.inject({
    method: "POST",
    url: `/status/${session.id}?k=${session.mediaKey}`,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: "CallStatus=busy&CallSid=CA2&SipResponseCode=486",
  });
  assert.equal(result.statusCode, 204);
  assert.equal(signalwireCount, 1);
  assert.equal(callbacks.length, 3);
  assert.equal(callbacks[0].body, callbacks[1].body);
  assert.equal(callbacks[1].body, callbacks[2].body);
  assert.equal(callbacks[0].signature, callbacks[2].signature);
  assert.equal(JSON.parse(callbacks[0].body).call_status, "busy");
  assert.equal(JSON.parse(callbacks[0].body).call_sid, "CA2");
  assert.ok(logs.some((entry) => entry.event === "status_callback" && entry.call_status === "busy"));
  assert.ok(logs.some((entry) => entry.event === "status_forward" && entry.result === "sent" && entry.http_status === 200));
  await bridge.app.close();
});

test("full media lifecycle routes real ElevenLabs events and logs no sensitive values", async () => {
  const logs = [];
  const carrierMessages = [];
  const destination = "+15555550123";
  const dynamicValue = "DYNAMIC_VALUE_CANARY_72e3a0d97c1c";
  const signedUrl = "wss://signed.example.test/session?token=SIGNED_URL_CANARY_9fbcb2";
  let provider;
  const FakeProvider = fakeProviderType((instance) => {
    provider = instance;
  });
  const bridge = createBridge(config, {
    log: (line) => logs.push(line),
    sessionGraceMs: 30,
    WebSocket: FakeProvider,
    fetch: async (url) => {
      const requestUrl = String(url);
      if (requestUrl.includes("get-signed-url")) {
        return new Response(JSON.stringify({ signed_url: signedUrl }), { status: 200 });
      }
      if (requestUrl.includes("/Calls.json")) {
        return new Response(JSON.stringify({ sid: "CA-SIM-1" }), { status: 201 });
      }
      if (requestUrl.includes("/Calls/CA-SIM-1.json")) {
        return new Response(JSON.stringify({ sid: "CA-SIM-1" }), { status: 200 });
      }
      if (requestUrl.includes("/api/webhooks/voice-bridge")) {
        return new Response("", { status: 200 });
      }
      throw new Error("unexpected_fetch");
    },
  });
  await bridge.app.ready();
  try {
    const call = await postCall(bridge, {
      actionId: "60000000-0000-4000-8000-000000000004",
      to: destination,
      dynamicVariables: { call_canary: dynamicValue },
    });
    assert.equal(call.statusCode, 200);
    const session = [...bridge.sessions.values()][0];
    const mediaKey = session.mediaKey;
    const rejectedTwiML = await bridge.app.inject({
      method: "POST",
      url: `/twiml/${session.id}`,
    });
    assert.equal(rejectedTwiML.statusCode, 404);
    const twiml = await bridge.app.inject({
      method: "POST",
      url: `/twiml/${session.id}?k=${mediaKey}`,
    });
    assert.equal(twiml.statusCode, 200);

    const carrier = await bridge.app.injectWS("/media");
    carrier.on("message", (raw) => carrierMessages.push(JSON.parse(raw.toString())));
    carrier.send(JSON.stringify({
      event: "start",
      start: {
        callSid: "CA-SIM-1",
        streamSid: "MZ-SIM-1",
        mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
        customParameters: { sessionId: session.id, key: mediaKey },
      },
    }));
    await waitFor(() => provider, "provider WebSocket was not created");
    provider.open();
    await waitFor(
      () => logs.some((line) => JSON.parse(line).event === "agent_ws_open"),
      "agent WebSocket did not open",
    );

    carrier.send(JSON.stringify({ event: "media", media: { payload: "CARRIER_AUDIO_CANARY" } }));
    await waitFor(
      () => provider.sent.some((raw) => JSON.parse(raw).user_audio_chunk === "CARRIER_AUDIO_CANARY"),
      "carrier audio was not forwarded to ElevenLabs",
    );
    provider.receive({
      type: "conversation_initiation_metadata",
      conversation_initiation_metadata_event: {
        conversation_id: "conv_simulated_session",
        user_input_audio_format: "ulaw_8000",
        agent_output_audio_format: "ulaw_8000",
      },
    });
    provider.receive({
      type: "audio",
      audio_event: { audio_base_64: "AGENT_AUDIO_CANARY", event_id: 1 },
    });
    provider.receive({ type: "ping", ping_event: { event_id: 17, ping_ms: 12 } });
    provider.receive({ type: "interruption", interruption_event: { event_id: 18 } });

    await waitFor(
      () => carrierMessages.some((message) => message.event === "media"),
      "agent audio was not forwarded to the carrier",
    );
    await waitFor(
      () => carrierMessages.some((message) => message.event === "clear"),
      "agent interruption did not clear carrier audio",
    );
    assert.deepEqual(carrierMessages.find((message) => message.event === "media"), {
      event: "media",
      streamSid: "MZ-SIM-1",
      media: { payload: "AGENT_AUDIO_CANARY" },
    });
    assert.ok(provider.sent.some((raw) => {
      const message = JSON.parse(raw);
      return message.type === "pong" && message.event_id === 17;
    }));
    assert.ok(carrierMessages.every((message) => message.type !== "pong"));

    provider.close(1005, `closed ${dynamicValue} ${signedUrl}`);
    await waitFor(
      () => logs.some((line) => JSON.parse(line).event === "hangup_requested"),
      "carrier hangup was not requested after agent disconnect",
    );
    const status = await bridge.app.inject({
      method: "POST",
      url: `/status/${session.id}?k=${mediaKey}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "CallStatus=completed&CallSid=CA-SIM-1&SipResponseCode=200",
    });
    assert.equal(status.statusCode, 204);
    carrier.close();
    await waitFor(
      () => logs.some((line) => JSON.parse(line).event === "carrier_ws_close"),
      "carrier WebSocket close was not logged",
    );
    await waitFor(
      () => logs.some((line) => JSON.parse(line).event === "session_cleanup"),
      "session cleanup was not logged",
    );

    const events = logs.map((line) => JSON.parse(line));
    const eventNames = events.map((entry) => entry.event);
    for (const event of [
      "call_created",
      "twiml_rejected",
      "twiml_served",
      "media_connected",
      "stream_start",
      "agent_ws_open",
      "agent_metadata",
      "first_carrier_audio",
      "first_agent_audio",
      "agent_interruption",
      "agent_ws_close",
      "hangup_requested",
      "status_callback",
      "status_forward",
      "carrier_ws_close",
      "session_cleanup",
    ]) {
      assert.ok(eventNames.includes(event), `missing ${event} log`);
    }
    const callCreated = events.find((entry) => entry.event === "call_created");
    assert.equal(callCreated.signalwire_http_status, 201);
    const streamStart = events.find((entry) => entry.event === "stream_start");
    assert.equal(streamStart.call_sid_match, true);
    const interrupted = events.find((entry) => entry.event === "agent_interruption");
    assert.deepEqual(Object.keys(interrupted).sort(), [
      "call_sid",
      "count",
      "event",
      "session",
      "t_ms",
    ]);
    assert.equal(interrupted.count, 1);
    const agentClose = events.find((entry) => entry.event === "agent_ws_close");
    assert.equal(agentClose.code, 1005);
    assert.ok(agentClose.reason.length <= 100);
    const hangupRequested = events.find((entry) => entry.event === "hangup_requested");
    assert.equal(hangupRequested.reason, "agent_end");
    assert.equal(hangupRequested.rest_status, 200);
    const cleanup = events.find((entry) => entry.event === "session_cleanup");
    assert.equal(cleanup.ended_first, "agent");
    assert.equal(cleanup.carrier_audio_chunks, 1);
    assert.equal(cleanup.agent_audio_chunks, 1);
    assert.equal(cleanup.interruption_count, 1);
    assert.ok(events.every((entry) => entry.session === session.id.slice(0, 8) || entry.event === "media_connected"));
    assert.ok(events.every((entry) => typeof entry.t_ms === "number" || entry.event === "media_connected"));
    assert.ok(logs.every((line) => !line.includes("\n")));

    const serializedLogs = logs.join("\n");
    for (const sensitive of [
      destination,
      config.signalwirePhoneNumber,
      mediaKey,
      signedUrl,
      dynamicValue,
      "CARRIER_AUDIO_CANARY",
      "AGENT_AUDIO_CANARY",
    ]) {
      assert.equal(serializedLogs.includes(sensitive), false, `log leaked ${sensitive}`);
    }
  } finally {
    await bridge.app.close();
  }
});

test("carrier stop is logged as the first side to end", async () => {
  const logs = [];
  let provider;
  const FakeProvider = fakeProviderType((instance) => {
    provider = instance;
  });
  const bridge = createBridge(config, {
    log: (line) => logs.push(JSON.parse(line)),
    sessionGraceMs: 10,
    WebSocket: FakeProvider,
    fetch: async (url) => {
      if (String(url).includes("get-signed-url")) {
        return new Response(JSON.stringify({ signed_url: "wss://signed.example.test/session" }), { status: 200 });
      }
      return new Response(JSON.stringify({ sid: "CA-STOP-1" }), { status: 200 });
    },
  });
  await bridge.app.ready();
  try {
    const call = await postCall(bridge, {
      actionId: "60000000-0000-4000-8000-000000000005",
      to: "+15555550124",
    });
    assert.equal(call.statusCode, 200);
    const session = [...bridge.sessions.values()][0];
    const carrier = await bridge.app.injectWS("/media");
    carrier.send(JSON.stringify({
      event: "start",
      start: {
        callSid: session.callSid,
        streamSid: "MZ-STOP-1",
        customParameters: { sessionId: session.id, key: session.mediaKey },
      },
    }));
    await waitFor(() => provider, "provider WebSocket was not created");
    provider.open();
    carrier.send(JSON.stringify({ event: "stop" }));
    await waitFor(
      () => logs.some((entry) => entry.event === "session_cleanup"),
      "session cleanup was not logged",
    );
    assert.ok(logs.some((entry) => entry.event === "carrier_stop"));
    assert.equal(logs.find((entry) => entry.event === "session_cleanup").ended_first, "carrier");
  } finally {
    await bridge.app.close();
  }
});
