import { describe, expect, it } from "vitest";
import { buildCallBrief, CALL_QUESTIONS } from "@/lib/integrations/elevenlabs/brief";
import { parseDecimalToMinor } from "@/lib/integrations/elevenlabs/money";
import { normalizeTranscription } from "@/lib/integrations/elevenlabs/outcomes";
import { SUPPLIER_CALL_PROMPT, SUPPLIER_CALL_PROMPT_VERSION } from "@/lib/integrations/elevenlabs/prompt";
import { supplierCallPayloadSchema } from "@/lib/integrations/elevenlabs/payload";
import { ACTION_A, CONTACT_A, createFakeVoiceStore, ORG_A } from "./voice-fakes";

describe("call brief", () => {
  it("includes identity, disclosure, order, quantity, deadline, questions and approval statement", async () => {
    const { store } = createFakeVoiceStore();
    const context = (await store.callContext(ORG_A, ACTION_A, CONTACT_A))!;
    const brief = buildCallBrief({ actionId: ACTION_A, context, payload: supplierCallPayloadSchema.parse({ contact_id: CONTACT_A }) });
    expect(brief.ok).toBe(true);
    if (!brief.ok) return;
    const v = brief.variables;
    expect(v).toMatchObject({ company_name: "Harbor Pack", order_ref: "PO-1001", qty_needed: 400, item_sku: "BOX-12", conduit_action_id: ACTION_A });
    expect(String(v.ai_disclosure)).toMatch(/AI assistant.*Harbor Pack/);
    expect(String(v.approval_statement)).toMatch(/owner has to approve/);
    expect(String(v.needed_by)).toMatch(/October 20, 2026/);
    expect(String(v.questions).split("\n")).toHaveLength(CALL_QUESTIONS.length);
    expect(JSON.stringify(v)).not.toMatch(/ceiling|budget|max(imum)? (price|pay)|secret/i);
  });

  it("refuses to build without a deterministic quantity", async () => {
    const { store } = createFakeVoiceStore();
    const context = (await store.callContext(ORG_A, ACTION_A, CONTACT_A))!;
    context.facts.bridge_qty = null;
    expect(buildCallBrief({ actionId: ACTION_A, context, payload: supplierCallPayloadSchema.parse({ contact_id: CONTACT_A }) })).toEqual({ ok: false, reason: "missing_quantity" });
  });

  it("rejects payloads that try to smuggle scope or prices", () => {
    expect(supplierCallPayloadSchema.safeParse({ contact_id: CONTACT_A, org_id: ORG_A }).success).toBe(false);
    expect(supplierCallPayloadSchema.safeParse({ contact_id: CONTACT_A, max_price_minor: 100 }).success).toBe(false);
  });

  it("versioned prompt forbids revealing willingness to pay and requires disclosure", () => {
    expect(SUPPLIER_CALL_PROMPT_VERSION).toBe("supplier-call.v1");
    expect(SUPPLIER_CALL_PROMPT).toMatch(/Never state, hint at or confirm any budget/);
    expect(SUPPLIER_CALL_PROMPT).toMatch(/AI assistant/);
    expect(SUPPLIER_CALL_PROMPT).not.toMatch(/secret__/);
  });
});

describe("money and outcomes", () => {
  it("parses decimals to integer minor units without floats", () => {
    expect(parseDecimalToMinor("12.5")).toBe(1250n);
    expect(parseDecimalToMinor("0.07")).toBe(7n);
    expect(parseDecimalToMinor("999999999999.99")).toBe(99999999999999n);
    expect(parseDecimalToMinor("1.005")).toBeNull();
    expect(parseDecimalToMinor("1e3")).toBeNull();
  });

  it("connected call with no supplier speech is no_answer, not initiation failure", () => {
    const outcome = normalizeTranscription(
      { status: "done", termination_reason: null, error_present: false, duration_seconds: 20, supplier_turns: 0, voicemail_detected: false },
      { offer_recorded: false, human_review_requested: false, end_call_logged: false },
    );
    expect(outcome).toMatchObject({ outcome: "no_answer", transport_completed: true, procurement_result: "not_reached" });
  });
});
