import { describe, expect, it } from "vitest";
import {
  buildTwiML,
  createSession,
  conversationMetadata,
  hasSupportedAudioFormats,
  isDestinationAllowed,
  parseAllowedTo,
  shouldSendStatus,
  translateAgentMessage,
  signalWireMediaToElevenLabs,
  signPayload,
  validateCallRequest,
  validateStartEvent,
  verifySignature,
} from "../../services/voice-bridge/lib.mjs";

const ACTION_ID = "60000000-0000-4000-8000-000000000001";

describe("pure voice bridge library", () => {
  it("signs and verifies request bodies with a timestamp tolerance", () => {
    const raw = '{"action_id":"x"}';
    const signature = signPayload(raw, "secret", 1_000);
    expect(verifySignature(raw, signature, "secret", 1_000_000).ok).toBe(true);
    expect(verifySignature(`${raw} `, signature, "secret", 1_000_000).ok).toBe(false);
    expect(verifySignature(raw, signature, "secret", 1_400_000).ok).toBe(false);
    expect(verifySignature(raw, "bad", "secret", 1_000_000).ok).toBe(false);
  });

  it("validates flat bounded dispatches and destination allowlists", () => {
    expect(validateCallRequest({ action_id: "bad", to: "+15555550100", dynamic_variables: {} }).ok).toBe(false);
    expect(validateCallRequest({ action_id: ACTION_ID, to: "555", dynamic_variables: {} }).ok).toBe(false);
    expect(validateCallRequest({ action_id: ACTION_ID, to: "+15555550100", dynamic_variables: { nested: {} } }).ok).toBe(false);
    expect(validateCallRequest({
      action_id: ACTION_ID,
      to: "+15555550100",
      dynamic_variables: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, "v"])),
    }).ok).toBe(false);
    expect(validateCallRequest({
      action_id: ACTION_ID,
      to: "+15555550100",
      dynamic_variables: { note: "x".repeat(4001) },
    }).ok).toBe(false);
    expect(parseAllowedTo("+15555550100")).toEqual(new Set(["+15555550100"]));
    expect(isDestinationAllowed("+15555550100", parseAllowedTo("+15555550100"))).toBe(true);
    expect(isDestinationAllowed("+15555550101", parseAllowedTo("+15555550100"))).toBe(false);
  });

  it("escapes TwiML capabilities and binds a single valid media stream", () => {
    const session = createSession({ actionId: ACTION_ID, dynamicVariables: {}, nowMs: 100 });
    session.id = "stream<&";
    session.mediaKey = "media<&";
    session.callSid = "CA1";
    expect(buildTwiML("https://bridge.example.test", session)).toContain("stream&lt;&amp;");
    expect(validateStartEvent(session, { sessionId: session.id, key: "wrong" }, "CA1", 100).ok).toBe(false);
    expect(validateStartEvent(session, { sessionId: session.id, key: session.mediaKey }, "CA2", 100).ok).toBe(false);
    expect(validateStartEvent(session, { sessionId: session.id, key: session.mediaKey }, "CA1", session.expiresAt + 1).ok).toBe(false);
    expect(validateStartEvent(session, { sessionId: session.id, key: session.mediaKey }, "CA1", 100).ok).toBe(true);
    session.streamActive = true;
    expect(validateStartEvent(session, { sessionId: session.id, key: session.mediaKey }, "CA1", 100).ok).toBe(false);
  });

  it("translates audio and status decisions", () => {
    expect(signalWireMediaToElevenLabs({ event: "media", media: { payload: "audio" } })).toEqual({ user_audio_chunk: "audio" });
    expect(translateAgentMessage({ type: "audio", audio_event: { audio_base_64: "audio", event_id: 1 } }, "M1")).toEqual({
      toCarrier: { event: "media", streamSid: "M1", media: { payload: "audio" } },
    });
    expect(translateAgentMessage({ type: "audio", audio: { chunk: "fallback" } }, "M1")).toEqual({
      toCarrier: { event: "media", streamSid: "M1", media: { payload: "fallback" } },
    });
    expect(translateAgentMessage({ type: "audio", audio: { audio_event: { audio_base_64: "wrong" } } }, "M1")).toBeNull();
    expect(translateAgentMessage({ type: "audio", audio_event: { audio_base_64: "audio" } }, null)).toBeNull();
    expect(translateAgentMessage({ type: "interruption", interruption_event: {} }, "M1")).toEqual({
      toCarrier: { event: "clear", streamSid: "M1" },
    });
    expect(translateAgentMessage({ type: "ping", ping_event: { event_id: "p1", ping_ms: 12 } }, "M1")).toEqual({
      toAgent: { type: "pong", event_id: "p1" },
    });
    const metadata = conversationMetadata({
      type: "conversation_initiation_metadata",
      conversation_initiation_metadata_event: {
        conversation_id: "conv",
        user_input_audio_format: "ulaw_8000",
        agent_output_audio_format: "ulaw_8000",
      },
    });
    expect(hasSupportedAudioFormats(metadata)).toBe(true);
    expect(shouldSendStatus({ conversationId: null, callStatus: "failed" })).toBe(true);
    expect(shouldSendStatus({ conversationId: "conv", callStatus: "failed" })).toBe(false);
  });
});
