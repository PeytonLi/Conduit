import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTwiML,
  createSession,
  hasSupportedAudioFormats,
  isDestinationAllowed,
  parseAllowedTo,
  signalWireMediaToElevenLabs,
  signPayload,
  shouldSendStatus,
  translateAgentMessage,
  validateCallRequest,
  validateStartEvent,
  verifySignature,
} from "./lib.mjs";

const ACTION_ID = "60000000-0000-4000-8000-000000000001";

test("signatures accept valid payloads and reject bad, stale, and malformed values", () => {
  const body = '{"a":1}';
  const header = signPayload(body, "secret", 1000);
  assert.equal(verifySignature(body, header, "secret", 1_000_000).ok, true);
  assert.equal(verifySignature('{"a":2}', header, "secret", 1_000_000).ok, false);
  assert.equal(verifySignature(body, signPayload(body, "secret", 0), "secret", 1_000_000).ok, false);
  assert.equal(verifySignature(body, "garbage", "secret", 1_000_000).ok, false);
});

test("dispatch validation rejects unsafe request shapes", () => {
  assert.equal(validateCallRequest({ action_id: "bad", to: "+15555550100", dynamic_variables: {} }).ok, false);
  assert.equal(validateCallRequest({ action_id: ACTION_ID, to: "555", dynamic_variables: {} }).ok, false);
  assert.equal(validateCallRequest({ action_id: ACTION_ID, to: "+15555550100", dynamic_variables: { nested: {} } }).ok, false);
  assert.equal(validateCallRequest({
    action_id: ACTION_ID,
    to: "+15555550100",
    dynamic_variables: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, "v"])),
  }).ok, false);
  assert.equal(validateCallRequest({
    action_id: ACTION_ID,
    to: "+15555550100",
    dynamic_variables: { note: "x".repeat(4001) },
  }).ok, false);
  assert.equal(validateCallRequest(
    { action_id: ACTION_ID, to: "+15555550100", dynamic_variables: {} },
    "x".repeat(65 * 1024),
  ).code, "body_too_large");
});

test("TwiML escapes capability values and start binding is single-use", () => {
  const session = createSession({ actionId: ACTION_ID, dynamicVariables: {} });
  session.id = "id<&";
  session.mediaKey = "key<&";
  session.callSid = "CA1";
  const twiml = buildTwiML("https://bridge.example.test", session);
  assert.match(twiml, /id&lt;&amp;/);
  assert.match(twiml, /key&lt;&amp;/);
  assert.equal(validateStartEvent(session, { sessionId: session.id, key: "wrong" }, "CA1").ok, false);
  assert.equal(validateStartEvent(session, { sessionId: session.id, key: session.mediaKey }, "wrong").ok, false);
  assert.equal(validateStartEvent(session, { sessionId: session.id, key: session.mediaKey }, "CA1").ok, true);
  session.streamActive = true;
  assert.equal(validateStartEvent(session, { sessionId: session.id, key: session.mediaKey }, "CA1").ok, false);
  assert.equal(validateStartEvent(session, { sessionId: session.id, key: session.mediaKey }, "CA1", session.expiresAt + 1).ok, false);
});

test("message translation, format checks, allowlists, and status decisions", () => {
  assert.deepEqual(signalWireMediaToElevenLabs({ event: "media", media: { payload: "AAAA" } }), { user_audio_chunk: "AAAA" });
  assert.deepEqual(translateAgentMessage({ type: "audio", audio_event: { audio_base_64: "BBBB", event_id: 1 } }, "M1"), {
    toCarrier: { event: "media", streamSid: "M1", media: { payload: "BBBB" } },
  });
  assert.deepEqual(translateAgentMessage({ type: "audio", audio: { chunk: "CCCC" } }, "M1"), {
    toCarrier: { event: "media", streamSid: "M1", media: { payload: "CCCC" } },
  });
  assert.equal(translateAgentMessage({ type: "audio", audio: { audio_event: { audio_base_64: "wrong shape" } } }, "M1"), null);
  assert.equal(translateAgentMessage({ type: "audio", audio_event: { audio_base_64: "BBBB" } }, null), null);
  assert.deepEqual(translateAgentMessage({ type: "interruption", interruption_event: { event_id: 4 } }, "M1"), {
    toCarrier: { event: "clear", streamSid: "M1" },
  });
  assert.deepEqual(translateAgentMessage({ type: "ping", ping_event: { event_id: 3, ping_ms: 12 } }, "M1"), {
    toAgent: { type: "pong", event_id: 3 },
  });
  assert.equal(hasSupportedAudioFormats({ userInputAudioFormat: "ulaw_8000", agentOutputAudioFormat: "ulaw_8000" }), true);
  assert.equal(hasSupportedAudioFormats({ userInputAudioFormat: "pcm_16000", agentOutputAudioFormat: "ulaw_8000" }), false);
  assert.equal(isDestinationAllowed("+15555550100", new Set(["+15555550100"])), true);
  assert.equal(isDestinationAllowed("+15555550101", new Set(["+15555550100"])), false);
  assert.deepEqual(parseAllowedTo("+15555550100,+15555550101"), new Set(["+15555550100", "+15555550101"]));
  assert.throws(() => parseAllowedTo("not-a-phone"), /BRIDGE_ALLOWED_TO/);
  assert.equal(shouldSendStatus({ conversationId: null, callStatus: "failed" }), true);
  assert.equal(shouldSendStatus({ conversationId: "conv", callStatus: "failed" }), false);
});
