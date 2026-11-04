import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { registerAdapter } from "@/lib/actions/adapters";
import { resolveAdapterForMode } from "@/lib/actions/dispatcher";
import { ReplayViolationError } from "@/lib/actions/replay";
import type { ActionRecord, ProviderAdapter } from "@/lib/actions/types";
import { createSupplierCallAdapter } from "@/lib/integrations/elevenlabs/adapter";
import type { VoiceProviderClient } from "@/lib/integrations/elevenlabs/client";
import { selectResearch } from "@/lib/integrations/exa/replay";
import type { GmailApi } from "@/lib/integrations/gmail/api";
import { createSupplierEmailAdapter } from "@/lib/integrations/gmail/outbound";
import { createReplayTransport } from "@/lib/integrations/gmail/replay";
import { ACTION_A, CASE_A, CONTACT_A, createFakeVoiceStore, fakeClock, ORG_A } from "./voice-fakes";

// AT-33: an environment running APP_ENV=replay must not reach a live provider,
// even when real provider keys are configured alongside it.
describe("AT-33 replay isolation with live keys present", () => {
  it("never resolves a live adapter for any action kind in replay mode", () => {
    const kinds = ["supplier_email", "supplier_call", "demo_ledger_amendment"] as const;
    for (const kind of kinds) {
      const live: ProviderAdapter = {
        kind,
        dispatch: vi.fn(async () => ({ outcome: "submitted" as const, safeSummary: "live" })),
        findResult: vi.fn(async () => ({ outcome: "confirmed" as const, safeSummary: "live" })),
      };
      registerAdapter(live);
      let resolved: ProviderAdapter | null = null;
      try {
        resolved = resolveAdapterForMode(kind, "replay");
      } catch (error) {
        expect(error).toBeInstanceOf(ReplayViolationError);
      }
      expect(resolved).not.toBe(live);
    }
  });

  it("does not place a call when the app runs in replay, even for a non-replay action", async () => {
    const provider = {
      transport: "media_bridge",
      startOutboundCall: vi.fn(),
      getConversation: vi.fn(),
      findConversationByActionId: vi.fn(),
    } as unknown as VoiceProviderClient;
    const adapter = createSupplierCallAdapter({
      store: createFakeVoiceStore().store,
      provider,
      appEnv: "replay",
      now: fakeClock().now,
    });
    const action: ActionRecord = {
      id: ACTION_A,
      orgId: ORG_A,
      caseId: CASE_A,
      kind: "supplier_call",
      idempotencyKey: "k",
      payloadHash: "h",
      payload: { purpose: "availability" },
      contactId: CONTACT_A,
      providerRef: null,
      mode: "sandbox",
    };
    const result = await adapter.dispatch(action);
    expect(result.outcome).toBe("failed");
    expect(provider.startOutboundCall).not.toHaveBeenCalled();
  });

  it("sends supplier email only through the replay transport", async () => {
    const live = { sendRaw: vi.fn(), listHistory: vi.fn(), getMessage: vi.fn() } as unknown as GmailApi;
    const transportFor = vi.fn(() => live);
    const replay = createReplayTransport();
    const adapter = createSupplierEmailAdapter({
      appEnv: () => "replay",
      transportFor,
      loadContact: async () => ({
        normalized_address: "alyssa@baycarton.example.com",
        outreach_approved_at: "2026-01-01T00:00:00Z",
        permitted_channels: ["email"],
        supplier_id: "s1",
      }),
      fromAddressFor: () => "ops@harbor.example",
      replayTransport: replay,
    });
    const result = await adapter.dispatch({
      id: "act-1",
      orgId: "org-1",
      caseId: "case-1",
      kind: "supplier_email",
      idempotencyKey: "k1",
      payloadHash: "h",
      payload: {
        template: "quote_request",
        connection_id: "00000000-0000-4000-8000-0000000000aa",
        contact_id: "00000000-0000-4000-8000-0000000000bb",
        to: "alyssa@baycarton.example.com",
        subject: "Quote needed",
        thread: null,
        facts: {
          item_sku: "CARTON-302015",
          item_description: "Shipping carton",
          specification: { length_mm: 300 },
          quantity: 600,
          unit: "carton",
          destination_name: "Main Warehouse",
          needed_by_local: "2026-10-20",
          quote_fields: ["unit_price", "freight"],
        },
        question: "Can you confirm?",
      },
      providerRef: null,
      mode: "live",
    });
    expect(result.outcome).not.toBe("failed");
    expect(result.safeSummary).toMatch(/replay/);
    expect(replay.sent).toHaveLength(1);
    expect(transportFor).not.toHaveBeenCalled();
  });

  it("keeps supplier research on fixtures when an Exa key is configured", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network used in replay"));
    const research = selectResearch({ EXA_API_KEY: "live-key" }, "replay", {
      clock: fakeClock(),
      fetchImpl,
    });
    await research.search("corrugated cartons 300mm", { numResults: 3 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
