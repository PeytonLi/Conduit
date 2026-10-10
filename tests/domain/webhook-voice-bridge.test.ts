import { describe, expect, it } from "vitest";
import { handleVoiceBridgeWebhook } from "@/lib/integrations/elevenlabs/bridge-webhook";
import { signConduitPayload } from "@/lib/integrations/elevenlabs/signature";
import { ACTION_A, CASE_A, CONTACT_A, createFakeVoiceStore, fakeClock, ORG_A } from "./voice-fakes";

const SECRET = "12345678901234567890123456789012";

async function setup() {
  const fake = createFakeVoiceStore();
  const clock = fakeClock();
  await fake.store.prepareCall({ orgId: ORG_A, actionId: ACTION_A, caseId: CASE_A, contactId: CONTACT_A, tokenHash: "hash", allowedTools: [], expiresAt: new Date(clock.now().getTime() + 60_000) });
  const deliver = async (status: string, signatureSecret = SECRET) => {
    const raw = JSON.stringify({
      type: "call_status",
      action_id: ACTION_A,
      call_sid: "CA_bridge",
      call_status: status,
      sip_response_code: status === "busy" ? 486 : undefined,
      reason: "carrier status",
      occurred_at: clock.now().toISOString(),
    });
    return handleVoiceBridgeWebhook(raw, signConduitPayload(raw, signatureSecret, Math.floor(clock.now().getTime() / 1000)), {
      store: fake.store,
      secret: SECRET,
      now: clock.now,
    });
  };
  return { fake, deliver, clock };
}

describe("voice bridge callback", () => {
  it("rejects bad and stale signatures and invalid payloads", async () => {
    const { deliver, clock } = await setup();
    expect((await deliver("failed", "wrong")).status).toBe(401);
    const raw = JSON.stringify({ type: "call_status" });
    expect((await handleVoiceBridgeWebhook(raw, signConduitPayload(raw, SECRET, Math.floor(clock.now().getTime() / 1000) - 3600), { store: (await setup()).fake.store, secret: SECRET, now: clock.now })).status).toBe(401);
    expect((await handleVoiceBridgeWebhook("{}", signConduitPayload("{}", SECRET, Math.floor(clock.now().getTime() / 1000)), { store: (await setup()).fake.store, secret: SECRET, now: clock.now })).status).toBe(400);
  });

  it("records initiation failures by action hint and acknowledges duplicates", async () => {
    for (const [status, outcome] of [["no-answer", "no_answer"], ["busy", "busy"], ["failed", "initiation_failed"]] as const) {
      const { fake, deliver } = await setup();
      const first = await deliver(status);
      expect(first.body).toMatchObject({ status: "recorded", outcome });
      const duplicate = await deliver(status);
      expect(duplicate.body.status).toBe("duplicate");
      expect(fake.sessions.get(ACTION_A)?.conversation_id).toBe("CA_bridge");
    }
  });
});
