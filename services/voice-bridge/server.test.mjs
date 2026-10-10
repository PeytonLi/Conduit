import assert from "node:assert/strict";
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

test("unauthenticated calls are rejected and duplicate action IDs do not dial twice", async () => {
  let dials = 0;
  const bridge = createBridge(config, {
    now: () => 1_000_000_000,
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
  const bridge = createBridge(config);
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
  } finally {
    await bridge.app.close();
  }
});

test("carrier status retries the same signed callback bytes and always acknowledges the carrier", async () => {
  const callbacks = [];
  let signalwireCount = 0;
  const bridge = createBridge(config, {
    now: () => 1_000_000_000,
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
  await bridge.app.close();
});
