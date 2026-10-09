import { describe, expect, it } from "vitest";
import { createRequestSupplierEmailTool } from "@/lib/agent/tools/request-supplier-email";
import { createRequestSupplierCallTool } from "@/lib/agent/tools/request-supplier-call";
import { supplierCallPayloadSchema } from "@/lib/integrations/elevenlabs/payload";
import { fixedClock } from "@/lib/agent/clock";
import {
  BAY_EMAIL_CONTACT,
  BAY_PHONE_CONTACT,
  NORTH_EMAIL_CONTACT,
  ctx,
  harborStore,
  clock,
  BAY_CARTON,
  createFakePreparer,
} from "./planner-test-helpers";

describe("NFR-011 outreach limits", () => {
  it("2 emails per supplier then the 3rd is rejected; duplicate -> same action id", async () => {
    const store = harborStore();
    const tool = createRequestSupplierEmailTool({ store, clock, preparer: createFakePreparer(store) });
    const r1 = await tool.run(ctx, {
      contact_id: BAY_EMAIL_CONTACT,
      purpose: "availability_request",
      required_fields: ["quantity"],
    });
    expect(r1.ok).toBe(true);
    const dup = await tool.run(ctx, {
      contact_id: BAY_EMAIL_CONTACT,
      purpose: "availability_request",
      required_fields: ["quantity"],
    });
    expect(dup.ok).toBe(true);
    if (r1.ok && dup.ok) {
      expect((dup.data as { action_id: string }).action_id).toBe(
        (r1.data as { action_id: string }).action_id,
      );
      expect((dup.data as { created: boolean }).created).toBe(false);
    }
    const r2 = await tool.run(ctx, {
      contact_id: BAY_EMAIL_CONTACT,
      purpose: "written_confirmation",
      required_fields: ["written_confirmation"],
    });
    expect(r2.ok).toBe(true);
    const r3 = await tool.run(ctx, {
      contact_id: BAY_EMAIL_CONTACT,
      purpose: "follow_up",
      required_fields: ["quantity"],
    });
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.code).toBe("budget_exhausted");
  });

  it("1 call per supplier, 3 per episode, 4th distinct supplier rejected", async () => {
    const store = harborStore();
    // 2026-10-12T18:00Z = 11:00 PT on a weekday: inside supplier hours.
    const inHours = fixedClock("2026-10-12T18:00:00Z");
    const call = createRequestSupplierCallTool({ store, clock: inHours, preparer: createFakePreparer(store) });
    const email = createRequestSupplierEmailTool({ store, clock, preparer: createFakePreparer(store) });

    const okCall = await call.run(ctx, {
      contact_id: BAY_PHONE_CONTACT,
      purpose: "availability_and_split",
      case_version: 1,
    });
    expect(okCall.ok).toBe(true);
    const preparedCall = [...store.actions.values()].find(
      (a) => a.idempotency_key === `${ctx.caseId}:1:call:${BAY_PHONE_CONTACT}:availability_and_split`,
    );
    expect(supplierCallPayloadSchema.parse(preparedCall?.payload)).toEqual({
      contact_id: BAY_PHONE_CONTACT,
      purpose: "availability_and_split",
      qty_needed: 600,
      needed_by: "2026-10-14T16:00:00Z",
      allowed_tradeoffs: [],
      extra_questions: [],
    });
    const dupCall = await call.run(ctx, {
      contact_id: BAY_PHONE_CONTACT,
      purpose: "confirm_terms",
      case_version: 1,
    });
    // Same supplier second call -> idempotent key differs but supplier cap hits.
    expect(dupCall.ok).toBe(false);
    if (!dupCall.ok) expect(dupCall.code).toBe("budget_exhausted");

    // Contact a second and third supplier via email to reach distinct limit.
    const e2 = await email.run(ctx, {
      contact_id: NORTH_EMAIL_CONTACT,
      purpose: "availability_request",
      required_fields: ["quantity"],
    });
    expect(e2.ok).toBe(true);
    // Add a third distinct contacted supplier via seeded action.
    await store.insertAction({
      id: "seed-k3",
      org_id: ctx.orgId,
      case_id: ctx.caseId,
      kind: "supplier_email",
      state: "prepared",
      payload: { supplier_id: "50000000-0000-4000-8000-000000000004", episode: 1 },
      payload_hash: "h",
      idempotency_key: "k3",
      mode: "replay",
      created_at: "2026-10-12T15:00:00Z",
      episode: 1,
    });
    // 4th distinct supplier (Budget Box) -> distinct supplier limit.
    const fourth = await email.run(ctx, {
      contact_id: "60000000-0000-4000-8000-000000000005",
      purpose: "availability_request",
      required_fields: ["quantity"],
    });
    expect(fourth.ok).toBe(false);
    if (!fourth.ok) expect(fourth.code).toBe("not_approved");
    void BAY_CARTON;
  });

  it("actions from a previous episode don't consume this episode's budget", async () => {
    const store = harborStore();
    // Two emails to Bay Carton recorded under episode 0 (current episode is 1).
    for (const key of ["prev-1", "prev-2"]) {
      await store.insertAction({
        id: `seed-${key}`,
        org_id: ctx.orgId,
        case_id: ctx.caseId,
        kind: "supplier_email",
        state: "prepared",
        payload: { supplier_id: BAY_CARTON, episode: 0 },
        payload_hash: "h",
        idempotency_key: key,
        mode: "replay",
        created_at: "2026-10-12T15:00:00Z",
        episode: 0,
      });
    }
    const tool = createRequestSupplierEmailTool({ store, clock, preparer: createFakePreparer(store) });
    const r = await tool.run(ctx, {
      contact_id: BAY_EMAIL_CONTACT,
      purpose: "availability_request",
      required_fields: ["quantity"],
    });
    expect(r.ok).toBe(true);
    const action = [...store.actions.values()].find(
      (a) => a.idempotency_key === `${ctx.caseId}:1:email:${BAY_EMAIL_CONTACT}:availability_request`,
    );
    expect(action?.payload.episode).toBe(1);
  });

  it("outside supplier hours is rejected (Saturday clock)", async () => {
    const store = harborStore();
    const saturday = fixedClock("2026-10-10T18:00:00Z"); // Sat 11:00 PT
    const tool = createRequestSupplierCallTool({ store, clock: saturday, preparer: createFakePreparer(store) });
    const result = await tool.run(ctx, {
      contact_id: BAY_PHONE_CONTACT,
      purpose: "confirm_terms",
      case_version: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("outside_supplier_hours");
  });

  it("outside supplier hours is rejected (06:00 PT)", async () => {
    const store = harborStore();
    const early = fixedClock("2026-10-12T13:00:00Z"); // Mon 06:00 PT
    const tool = createRequestSupplierCallTool({ store, clock: early, preparer: createFakePreparer(store) });
    const result = await tool.run(ctx, {
      contact_id: BAY_PHONE_CONTACT,
      purpose: "confirm_terms",
      case_version: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("outside_supplier_hours");
  });

  it("stale case_version is rejected", async () => {
    const store = harborStore();
    const tool = createRequestSupplierCallTool({
      store,
      clock: fixedClock("2026-10-12T18:00:00Z"),
      preparer: createFakePreparer(store),
    });
    const result = await tool.run(ctx, {
      contact_id: BAY_PHONE_CONTACT,
      purpose: "confirm_terms",
      case_version: 99,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("stale_case_version");
  });

  it("actions are only ever created in state 'prepared'", async () => {
    const store = harborStore();
    const tool = createRequestSupplierEmailTool({ store, clock, preparer: createFakePreparer(store) });
    await tool.run(ctx, {
      contact_id: BAY_EMAIL_CONTACT,
      purpose: "availability_request",
      required_fields: ["quantity"],
    });
    for (const action of store.actions.values()) {
      expect(action.state).toBe("prepared");
    }
  });
});
