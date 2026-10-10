import { describe, expect, it, vi } from "vitest";
import { ElevenLabsError } from "@elevenlabs/elevenlabs-js";
import type { ActionRecord } from "@/lib/actions/types";
import { createSupplierCallAdapter } from "@/lib/integrations/elevenlabs/adapter";
import { hashVoiceToken, VOICE_TOKEN_DYNAMIC_VARIABLE } from "@/lib/integrations/elevenlabs/capability";
import { ProviderHttpError, type VoiceProviderClient } from "@/lib/integrations/elevenlabs/client";
import { ACTION_A, CASE_A, CONTACT_A, createFakeVoiceStore, fakeClock, ORG_A } from "./voice-fakes";

function action(mode: ActionRecord["mode"] = "sandbox", overrides: Partial<ActionRecord> = {}): ActionRecord {
  return {
    id: ACTION_A,
    orgId: ORG_A,
    caseId: CASE_A,
    kind: "supplier_call",
    idempotencyKey: "k",
    payloadHash: "h",
    payload: { purpose: "availability and split delivery" },
    contactId: CONTACT_A,
    providerRef: null,
    mode,
    ...overrides,
  };
}

function provider(overrides: Partial<VoiceProviderClient> = {}): VoiceProviderClient & { startOutboundCall: ReturnType<typeof vi.fn> } {
  return {
    transport: "sip_trunk",
    startOutboundCall: vi.fn(async () => ({ success: true, message: "ok", conversationId: "conv_1", sipCallId: "sip_1" })),
    getConversation: vi.fn(async () => null),
    findConversationByActionId: vi.fn(async () => null),
    ...overrides,
  } as VoiceProviderClient & { startOutboundCall: ReturnType<typeof vi.fn> };
}

function adapterWith(p: VoiceProviderClient | null, appEnv: "replay" | "sandbox" | "live" = "sandbox") {
  const fake = createFakeVoiceStore();
  const adapter = createSupplierCallAdapter({ store: fake.store, provider: p, appEnv, now: fakeClock().now });
  return { fake, adapter };
}

describe("supplier_call dispatch", () => {
  it("passes the brief as dynamic variables and the token only as a secret__ variable", async () => {
    const p = provider();
    const { adapter, fake } = adapterWith(p);
    const result = await adapter.dispatch(action());
    expect(result).toMatchObject({ outcome: "submitted", providerRef: "conv_1" });
    const vars = p.startOutboundCall.mock.calls[0][0].dynamicVariables as Record<string, string>;
    const token = vars[VOICE_TOKEN_DYNAMIC_VARIABLE];
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fake.grants[0].hash).toBe(hashVoiceToken(token));
    const nonSecret = Object.entries(vars).filter(([k]) => !k.startsWith("secret__"));
    expect(JSON.stringify(nonSecret)).not.toContain(token);
    expect(vars.ai_disclosure).toMatch(/AI assistant/);
    expect(fake.sessions.get(ACTION_A)).toMatchObject({ conversation_id: "conv_1", sip_call_id: "sip_1" });
  });

  it("replay mode never calls the provider", async () => {
    const p = provider({ startOutboundCall: vi.fn(async () => { throw new Error("must not dial"); }) });
    const { adapter } = adapterWith(p, "replay");
    const result = await adapter.dispatch(action("replay"));
    expect(result.outcome).toBe("submitted");
    expect(result.safeSummary).toMatch(/Replay/);
    expect(p.startOutboundCall).not.toHaveBeenCalled();
    expect(await adapter.findResult(action("replay"))).toMatchObject({ outcome: "unknown" });
  });

  it("uses the action contact when the payload only carries a purpose", async () => {
    const p = provider();
    const { adapter } = adapterWith(p);
    expect((await adapter.dispatch(action())).outcome).toBe("submitted");
    expect(p.startOutboundCall).toHaveBeenCalledOnce();
  });

  it("rejects a payload contact that differs from the action contact", async () => {
    const p = provider();
    const { adapter } = adapterWith(p);
    const result = await adapter.dispatch(
      action("sandbox", { payload: { contact_id: "50000000-0000-4000-8000-000000000002", purpose: "availability" } }),
    );
    expect(result).toEqual({
      outcome: "failed",
      safeSummary: "Call payload contact does not match the action contact; no call placed.",
    });
    expect(p.startOutboundCall).not.toHaveBeenCalled();
  });

  it("rejects a call with neither an action nor payload contact", async () => {
    const p = provider();
    const { adapter } = adapterWith(p);
    const result = await adapter.dispatch(action("sandbox", { contactId: null, payload: { purpose: "availability" } }));
    expect(result).toEqual({
      outcome: "failed",
      safeSummary: "Call payload has no contact; no call placed.",
    });
    expect(p.startOutboundCall).not.toHaveBeenCalled();
  });

  it("fails closed for live actions in a replay environment or without credentials", async () => {
    const p = provider();
    expect((await adapterWith(p, "replay").adapter.dispatch(action("live"))).outcome).toBe("failed");
    expect((await adapterWith(null, "live").adapter.dispatch(action("live"))).outcome).toBe("failed");
    expect(p.startOutboundCall).not.toHaveBeenCalled();
  });

  it("a definite 4xx rejection fails and revokes the grant", async () => {
    const p = provider({ startOutboundCall: vi.fn(async () => { throw new ElevenLabsError({ message: "bad", statusCode: 422 }); }) });
    const { adapter, fake } = adapterWith(p);
    expect((await adapter.dispatch(action())).outcome).toBe("failed");
    expect(fake.grants[0].revoked_at).not.toBeNull();
  });

  it("submits a media-bridge call using its SignalWire SID", async () => {
    const p = provider({
      transport: "media_bridge",
      startOutboundCall: vi.fn(async () => ({ success: true, message: "ok", sipCallId: "CA_bridge" })),
    });
    const { adapter, fake } = adapterWith(p);
    const order: string[] = [];
    const prepareCall = fake.store.prepareCall.bind(fake.store);
    fake.store.prepareCall = async (input) => {
      order.push("prepare");
      return prepareCall(input);
    };
    p.startOutboundCall.mockImplementation(async () => {
      order.push("dispatch");
      return { success: true, message: "ok", sipCallId: "CA_bridge" };
    });
    const result = await adapter.dispatch(action());
    expect(result).toMatchObject({ outcome: "submitted", providerRef: "CA_bridge" });
    expect(order).toEqual(["prepare", "dispatch"]);
    expect((await adapter.dispatch(action())).outcome).toBe("unknown");
    expect(p.startOutboundCall).toHaveBeenCalledOnce();
    expect(fake.sessions.get(ACTION_A)).toMatchObject({ conversation_id: null, sip_call_id: "CA_bridge" });
  });

  it("treats bridge timeouts and 5xx as ambiguous and bridge 4xx as rejected", async () => {
    const ambiguous = provider({
      transport: "media_bridge",
      startOutboundCall: vi.fn(async () => { throw new Error("timeout"); }),
    });
    const { adapter } = adapterWith(ambiguous);
    expect((await adapter.dispatch(action())).outcome).toBe("unknown");
    expect((await adapter.dispatch(action())).outcome).toBe("unknown");
    expect(ambiguous.startOutboundCall).toHaveBeenCalledOnce();

    const rejected = provider({
      transport: "media_bridge",
      startOutboundCall: vi.fn(async () => { throw new ProviderHttpError("rejected", 422); }),
    });
    expect((await adapterWith(rejected).adapter.dispatch(action())).outcome).toBe("failed");
  });

  it("does not treat a media-bridge SID as an ElevenLabs conversation ID", async () => {
    const p = provider({
      transport: "media_bridge",
      startOutboundCall: vi.fn(async () => ({ success: true, message: "ok", sipCallId: "CA_bridge" })),
      getConversation: vi.fn(async () => {
        throw new Error("bridge SID must not be looked up");
      }),
      findConversationByActionId: vi.fn(async () => ({
        conversationId: "conv_bridge_late",
        status: "done",
        terminationReason: null,
        callDurationSecs: 14,
        actionId: ACTION_A,
        sipCallId: "CA_bridge",
      })),
    });
    const { adapter } = adapterWith(p);
    const first = await adapter.dispatch(action());
    expect(first.providerRef).toBe("CA_bridge");
    const result = await adapter.findResult(action("sandbox", { providerRef: "CA_bridge" }));
    expect(result).toMatchObject({ outcome: "confirmed", providerRef: "conv_bridge_late" });
    expect(p.getConversation).not.toHaveBeenCalled();
  });
});

describe("AT-25 call timeout becomes unknown with no second call", () => {
  it("lost response -> unknown, retry does not dial again, reconcile finds the conversation", async () => {
    const p = provider({
      startOutboundCall: vi.fn(async () => { throw new Error("socket timeout"); }),
      findConversationByActionId: vi.fn(async () => ({ conversationId: "conv_late", status: "done", terminationReason: null, callDurationSecs: 61, actionId: ACTION_A, sipCallId: "sip_9" })),
    });
    const { adapter, fake } = adapterWith(p);
    const first = await adapter.dispatch(action());
    expect(first.outcome).toBe("unknown");
    const second = await adapter.dispatch(action());
    expect(second.outcome).toBe("unknown");
    expect(second.safeSummary).toMatch(/not|instead of redialing/i);
    expect(p.startOutboundCall).toHaveBeenCalledTimes(1);

    const reconciled = await adapter.findResult(action());
    expect(reconciled).toMatchObject({ outcome: "confirmed", providerRef: "conv_late" });
    expect(fake.sessions.get(ACTION_A)?.conversation_id).toBe("conv_late");
    expect(p.startOutboundCall).toHaveBeenCalledTimes(1);
  });

  it("5xx and 429 are ambiguous, never failed", async () => {
    for (const statusCode of [500, 503, 429, 408]) {
      const p = provider({ startOutboundCall: vi.fn(async () => { throw new ElevenLabsError({ message: "x", statusCode }); }) });
      expect((await adapterWith(p).adapter.dispatch(action())).outcome).toBe("unknown");
    }
  });

  it("reconcile without a match stays unknown (absence is not inferred)", async () => {
    const p = provider({ startOutboundCall: vi.fn(async () => { throw new Error("timeout"); }) });
    const { adapter } = adapterWith(p);
    await adapter.dispatch(action());
    expect((await adapter.findResult(action())).outcome).toBe("unknown");
  });
});

describe("AT-27 pause / in-flight call", () => {
  it("a paused case dispatches no new call", async () => {
    const p = provider();
    const { adapter, fake } = adapterWith(p);
    fake.cases.get(CASE_A)!.run_control = "paused";
    const result = await adapter.dispatch(action());
    expect(result.outcome).toBe("failed");
    expect(result.safeSummary).toMatch(/paused/);
    expect(p.startOutboundCall).not.toHaveBeenCalled();
    expect(fake.grants).toHaveLength(0);
  });

  it("pausing after start leaves the in-flight call visible and blocks re-dispatch", async () => {
    const p = provider();
    const { adapter, fake } = adapterWith(p);
    await adapter.dispatch(action());
    fake.cases.get(CASE_A)!.run_control = "paused";
    expect(fake.sessions.get(ACTION_A)).toMatchObject({ conversation_id: "conv_1", ended_at: null });
    expect((await adapter.dispatch(action())).outcome).not.toBe("submitted");
    expect(p.startOutboundCall).toHaveBeenCalledTimes(1);
  });

  it("another in-flight call in the org blocks a new dispatch", async () => {
    const p = provider();
    const { adapter, fake } = adapterWith(p);
    fake.setOtherCallsInFlight(1);
    expect((await adapter.dispatch(action())).outcome).toBe("failed");
    expect(p.startOutboundCall).not.toHaveBeenCalled();
  });

  it("contacts not approved for phone outreach are never dialed", async () => {
    const p = provider();
    const { adapter, fake } = adapterWith(p);
    fake.contactPermitted.set(CONTACT_A, false);
    expect((await adapter.dispatch(action())).outcome).toBe("failed");
    expect(p.startOutboundCall).not.toHaveBeenCalled();
  });
});
