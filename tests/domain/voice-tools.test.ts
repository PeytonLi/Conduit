import { describe, expect, it } from "vitest";
import { generateVoiceToken, hashVoiceToken, VOICE_GRANT_TTL_MS, VOICE_TOOL_NAMES } from "@/lib/integrations/elevenlabs/capability";
import { toInstant } from "@/lib/integrations/elevenlabs/offer-evaluation";
import { handleVoiceToolRequest } from "@/lib/integrations/elevenlabs/tools";
import { ACTION_A, ACTION_B, CASE_A, CASE_B, CONTACT_A, CONTACT_B, createFakeVoiceStore, fakeClock, ORG_A, ORG_B } from "./voice-fakes";

async function setup(tools: readonly string[] = VOICE_TOOL_NAMES) {
  const fake = createFakeVoiceStore();
  const clock = fakeClock();
  const tokenA = generateVoiceToken();
  const tokenB = generateVoiceToken();
  await fake.store.prepareCall({ orgId: ORG_A, actionId: ACTION_A, caseId: CASE_A, contactId: CONTACT_A, tokenHash: hashVoiceToken(tokenA), allowedTools: tools, expiresAt: new Date(clock.now().getTime() + VOICE_GRANT_TTL_MS) });
  await fake.store.prepareCall({ orgId: ORG_B, actionId: ACTION_B, caseId: CASE_B, contactId: CONTACT_B, tokenHash: hashVoiceToken(tokenB), allowedTools: VOICE_TOOL_NAMES, expiresAt: new Date(clock.now().getTime() + VOICE_GRANT_TTL_MS) });
  const call = (tool: string, token: string | null, body: unknown = {}) => handleVoiceToolRequest(tool, token, body, { store: fake.store, now: clock.now });
  return { fake, clock, tokenA, tokenB, call };
}

const goodOffer = {
  quantity: 400,
  currency: "USD",
  unit_price: "1.30",
  freight: "50.00",
  arrival_date: "2026-10-18",
  quote_valid_until: "2026-10-14",
  order_cutoff: "2026-10-13T20:00:00Z",
  split_delivery: false,
};

describe("AT-14 voice tool grant scoping", () => {
  it("a grant reads only its own org/case facts", async () => {
    const { call, tokenA } = await setup();
    const res = await call("read_case_facts", tokenA);
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    expect(text).toContain("PO-1001");
    expect(text).not.toContain("PO-B-9");
    expect(text).not.toContain("SECRET-B");
  });

  it("rejects model-supplied org_id/case_id instead of honoring them", async () => {
    const { call, tokenA, fake } = await setup();
    const res = await call("read_case_facts", tokenA, { org_id: ORG_B, case_id: CASE_B });
    expect(res.status).toBe(422);
    const offer = await call("record_provisional_offer", tokenA, { ...goodOffer, case_id: CASE_B });
    expect(offer.status).toBe(422);
    expect(fake.quotes).toHaveLength(0);
  });

  it("rejects missing, unknown, expired and revoked credentials", async () => {
    const { call, tokenA, clock, fake } = await setup();
    expect((await call("read_case_facts", null)).status).toBe(401);
    expect((await call("read_case_facts", generateVoiceToken())).status).toBe(401);
    clock.advance(VOICE_GRANT_TTL_MS - 1);
    expect((await call("read_case_facts", tokenA)).status).toBe(200);
    clock.advance(1);
    const expired = await call("read_case_facts", tokenA);
    expect(expired).toMatchObject({ status: 401, body: { code: "grant_expired" } });
    await fake.store.revokeGrants(ORG_A, ACTION_A, clock.now());
    expect((await call("read_case_facts", tokenA)).body).toMatchObject({ code: "grant_revoked" });
  });

  it("enforces the per-grant tool allowlist and unknown tools", async () => {
    const { call, tokenA } = await setup(["read_case_facts", "end_call"]);
    expect((await call("record_provisional_offer", tokenA, goodOffer)).status).toBe(403);
    expect((await call("approve_plan", tokenA)).status).toBe(404);
  });

  it("stores only the token hash, never the token", async () => {
    const { fake, tokenA } = await setup();
    expect(JSON.stringify(fake.grants)).not.toContain(tokenA);
    expect(fake.grants[0].hash).toBe(hashVoiceToken(tokenA));
  });
});

describe("AT-16 negotiation boundary", () => {
  it("an above-ceiling offer stays provisional and raises an owner task", async () => {
    const { call, tokenA, fake } = await setup();
    // premium (1.30-1.20)*400 = 40.00 + freight 600.00 = 640.00 > ceiling 500.00
    const res = await call("record_provisional_offer", tokenA, { ...goodOffer, freight: "600.00" });
    expect(res.status).toBe(200);
    expect(fake.quotes).toHaveLength(1);
    expect(fake.quotes[0]).toMatchObject({ status: "provisional", added_cost_minor: "64000", unit_price_minor: "130", owner_task_kind: "above_ceiling" });
    expect(fake.ownerTasks.map((t) => t.kind)).toEqual(["above_ceiling"]);
    expect(fake.cases.get(CASE_A)!.phase).toBe("awaiting_supplier");
  });

  it("responds identically within and above the ceiling so the agent cannot learn it", async () => {
    const { call, tokenA } = await setup();
    const within = await call("record_provisional_offer", tokenA, goodOffer);
    const above = await call("record_provisional_offer", tokenA, { ...goodOffer, freight: "600.00" });
    const strip = (r: typeof within) => ({ ...r, body: { ...r.body, data: { ...(r.body as { data: object }).data, quote_id: "x" } } });
    expect(strip(within)).toEqual(strip(above));
    expect(JSON.stringify(above.body)).not.toMatch(/ceiling|500|budget/i);
  });

  it("a within-ceiling offer is still only provisional and raises no ceiling task", async () => {
    const { call, tokenA, fake } = await setup();
    await call("record_provisional_offer", tokenA, goodOffer);
    expect(fake.quotes[0].status).toBe("provisional");
    expect(fake.quotes[0].added_cost_minor).toBe("9000");
    expect(fake.ownerTasks).toHaveLength(0);
  });

  it("missing ceiling or uncomputable cost always needs owner review", async () => {
    const { call, tokenA, fake } = await setup();
    fake.offerContexts.get(CASE_A)!.negotiation_ceiling_minor = null;
    await call("record_provisional_offer", tokenA, goodOffer);
    await call("record_provisional_offer", tokenA, { quantity: 100 });
    expect(fake.ownerTasks.map((t) => t.kind)).toEqual(["ceiling_not_configured", "human_review"]);
  });

  it("validate_offer reports missing fields deterministically without pricing judgments", async () => {
    const { call, tokenA } = await setup();
    const res = await call("validate_offer", tokenA, { quantity: 300, arrival_date: "2026-10-25" });
    expect(res.body).toMatchObject({ ok: true, data: { meets_quantity: false, meets_deadline: false } });
    expect((res.body as unknown as { data: { missing_fields: string[] } }).data.missing_fields).toContain("unit_price");
  });

  it("uses the case-local end of day for date-only arrival comparison and persistence", async () => {
    const { call, tokenA, fake } = await setup();
    const arrivalBy = "2026-10-17T06:59:59.999Z";
    fake.offerContexts.get(CASE_A)!.timezone = "America/Los_Angeles";
    fake.offerContexts.get(CASE_A)!.first_shortage_at = "2026-10-17T03:00:00.000Z";

    expect(toInstant("2026-10-16", "America/Los_Angeles")?.toISOString()).toBe(arrivalBy);

    const validation = await call("validate_offer", tokenA, { ...goodOffer, arrival_date: "2026-10-16" });
    expect(validation.body).toMatchObject({ ok: true, data: { meets_deadline: false } });

    await call("record_provisional_offer", tokenA, { ...goodOffer, arrival_date: "2026-10-16" });
    expect(fake.quotes[0].arrival_by).toBe(arrivalBy);
  });

  it("rejects float-like or negative money", async () => {
    const { call, tokenA } = await setup();
    expect((await call("validate_offer", tokenA, { ...goodOffer, unit_price: "1.305" })).status).toBe(422);
    expect((await call("validate_offer", tokenA, { ...goodOffer, unit_price: "-1" })).status).toBe(422);
  });
});

describe("AT-27 pause during a call", () => {
  it("blocks recording/negotiating tools but lets the call end cleanly", async () => {
    const { call, tokenA, fake } = await setup();
    fake.cases.get(CASE_A)!.run_control = "paused";
    const res = await call("record_provisional_offer", tokenA, goodOffer);
    expect(res).toMatchObject({ status: 409, body: { code: "case_paused" } });
    expect(fake.quotes).toHaveLength(0);
    expect((await call("read_case_facts", tokenA)).status).toBe(409);
    expect((await call("request_human_review", tokenA, { reason: "case_paused" })).status).toBe(200);
    expect((await call("end_call", tokenA, { reason: "case_paused" })).status).toBe(200);
    expect(fake.toolEvents.map((e) => e.resultCode)).toContain("denied_case_paused");
    expect(fake.sessions.has(ACTION_A)).toBe(true);
  });
});
