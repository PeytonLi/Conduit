import { describe, expect, it } from "vitest";
import { createRecordProvisionalOfferTool } from "@/lib/agent/tools/record-provisional-offer";
import { createProposeRecoveryPlanTool } from "@/lib/agent/tools/propose-recovery-plan";
import { createToolRegistry, TOOL_NAMES } from "@/lib/agent/tools/registry";
import { evaluateQuote } from "@/lib/agent/quote-evaluation";
import { runPlannerCycle } from "@/lib/agent/planner";
import {
  createFakePreparer,
  ASSESSMENT_A,
  ctx,
  FakeStep,
  harborStore,
  scriptedModel,
  clock,
  ctx as baseCtx,
  toolCallTurn,
  ITEM_A,
  LOCATION_A,
} from "./planner-test-helpers";
import type { QuoteRecord } from "@/lib/agent/store";

function verifiedQuote(overrides: Partial<QuoteRecord> = {}): QuoteRecord {
  return {
    id: "q-1",
    org_id: ctx.orgId,
    case_id: ctx.caseId,
    offer_id: null,
    supplier_id: "50000000-0000-4000-8000-000000000002",
    contact_id: null,
    item_id: ITEM_A,
    quantity: 600,
    unit: "carton",
    unit_price_minor: "42",
    currency: "USD",
    freight_minor: "6000",
    fees_minor: "0",
    nonrecoverable_tax_minor: "0",
    destination_location_id: LOCATION_A,
    arrival_start: "2026-10-14T00:00:00Z",
    arrival_end: "2026-10-14T16:00:00Z",
    valid_until: "2026-10-13T00:00:00Z",
    latest_order_at: "2026-10-12T20:00:00Z",
    status: "verified",
    evidence_ids: ["70000000-0000-4000-8000-000000000004"],
    ...overrides,
  };
}

describe("AT-16 negotiation and plan authority", () => {
  it("canonical landed cost: 600 @ 42 + 6000 freight = 31200", () => {
    const store = harborStore();
    const item = { id: ITEM_A, org_id: ctx.orgId, sku: "S", description: "", base_unit: "carton", specification: {} };
    const evaln = evaluateQuote(verifiedQuote(), item, clock.now());
    expect(evaln.landed_cost_minor).toBe("31200");
    expect(evaln.missing_terms).toEqual([]);
    void store;
  });

  it("record_provisional_offer rejects a status arg and always stores provisional", async () => {
    const store = harborStore();
    const tool = createRecordProvisionalOfferTool({ store, clock, preparer: createFakePreparer(store) });
    const bad = await tool.run(ctx, {
      supplier_id: "50000000-0000-4000-8000-000000000002",
      source_evidence_id: "70000000-0000-4000-8000-000000000004",
      quantity: 600,
      unit: "carton",
      unit_price_minor: "42",
      currency: "USD",
      status: "verified",
    } as unknown as Parameters<typeof tool.run>[1]);
    expect(bad.ok).toBe(false);

    const good = await tool.run(ctx, {
      supplier_id: "50000000-0000-4000-8000-000000000002",
      source_evidence_id: "70000000-0000-4000-8000-000000000004",
      quantity: 600,
      unit: "carton",
      unit_price_minor: "42",
      currency: "USD",
    });
    expect(good.ok).toBe(true);
    if (good.ok) {
      const data = good.data as { status: string; quote_id: string };
      expect(data.status).toBe("provisional");
    }
  });

  it("provisional quote -> draft plan with missing written confirmation", async () => {
    const store = harborStore();
    await store.insertQuote(verifiedQuote({ status: "provisional", evidence_ids: [] }));
    const tool = createProposeRecoveryPlanTool({ store, clock, preparer: createFakePreparer(store) });
    const result = await tool.run(ctx, {
      assessment_id: ASSESSMENT_A,
      steps: [{ step_id: "s1", kind: "purchase_bridge", quantity: 600, quote_id: "q-1" }],
      evidence_ids: ["70000000-0000-4000-8000-000000000004"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as { status: string; missing_fields: string[] };
      expect(data.status).toBe("draft");
      expect(data.missing_fields.join(" ")).toContain("quote_not_verified");
    }
  });

  it("verified complete quote under a configured ceiling -> ready", async () => {
    const store = harborStore();
    await store.insertQuote(verifiedQuote());
    store.policies.push({
      id: "pol-1",
      org_id: ctx.orgId,
      version: 1,
      settings: { procurement_ceiling_minor: "100000" },
    });
    const tool = createProposeRecoveryPlanTool({ store, clock, preparer: createFakePreparer(store) });
    const result = await tool.run(ctx, {
      assessment_id: ASSESSMENT_A,
      steps: [
        { step_id: "s1", kind: "purchase_bridge", quantity: 200, quote_id: "q-1" },
        { step_id: "s2", kind: "purchase_bridge", quantity: 400, quote_id: "q-1" },
      ],
      evidence_ids: ["70000000-0000-4000-8000-000000000004"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect((result.data as { status: string }).status).toBe("ready");
  });

  it("above ceiling or absent ceiling -> draft + owner review", async () => {
    for (const withCeiling of [true, false]) {
      const store = harborStore();
      await store.insertQuote(verifiedQuote());
      if (withCeiling) {
        store.policies.push({
          id: "pol-1",
          org_id: ctx.orgId,
          version: 1,
          settings: { procurement_ceiling_minor: "100" },
        });
      }
      const tool = createProposeRecoveryPlanTool({ store, clock, preparer: createFakePreparer(store) });
      const result = await tool.run(ctx, {
        assessment_id: ASSESSMENT_A,
        steps: [{ step_id: "s1", kind: "purchase_bridge", quantity: 600, quote_id: "q-1" }],
        evidence_ids: ["70000000-0000-4000-8000-000000000004"],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const data = result.data as { status: string; owner_review_raised: boolean };
        expect(data.status).toBe("draft");
        expect(data.owner_review_raised).toBe(true);
      }
      expect([...store.reviews.values()].length).toBe(1);
    }
  });

  it("amend_delivery_schedule without quote_id -> missing_quote", async () => {
    const store = harborStore();
    const tool = createProposeRecoveryPlanTool({ store, clock, preparer: createFakePreparer(store) });
    const result = await tool.run(ctx, {
      assessment_id: ASSESSMENT_A,
      steps: [{ step_id: "s1", kind: "amend_delivery_schedule", quantity: 600 }],
      evidence_ids: ["70000000-0000-4000-8000-000000000004"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("missing_quote");
  });

  it("Bay Carton split amend: only freight+fees+tax count -> 7500 gross and incremental", async () => {
    const store = harborStore();
    await store.insertQuote(
      verifiedQuote({
        id: "q-amend",
        supplier_id: "50000000-0000-4000-8000-000000000001",
        freight_minor: "7500",
        arrival_end: "2026-10-14T16:00:00Z",
      }),
    );
    const tool = createProposeRecoveryPlanTool({ store, clock, preparer: createFakePreparer(store) });
    const result = await tool.run(ctx, {
      assessment_id: ASSESSMENT_A,
      steps: [
        { step_id: "s1", kind: "amend_delivery_schedule", quantity: 600, quote_id: "q-amend" },
      ],
      evidence_ids: ["70000000-0000-4000-8000-000000000004"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as {
        gross_commitment_minor: string | null;
        incremental_cost_minor: string | null;
      };
      expect(data.gross_commitment_minor).toBe("7500");
      expect(data.incremental_cost_minor).toBe("7500");
    }
  });

  it("North Packaging bridge: full landed 31200 for gross and incremental", async () => {
    const store = harborStore();
    await store.insertQuote(verifiedQuote());
    const tool = createProposeRecoveryPlanTool({ store, clock, preparer: createFakePreparer(store) });
    const result = await tool.run(ctx, {
      assessment_id: ASSESSMENT_A,
      steps: [{ step_id: "s1", kind: "purchase_bridge", quantity: 600, quote_id: "q-1" }],
      evidence_ids: ["70000000-0000-4000-8000-000000000004"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as {
        status: string;
        gross_commitment_minor: string | null;
        incremental_cost_minor: string | null;
      };
      expect(data.gross_commitment_minor).toBe("31200");
      expect(data.incremental_cost_minor).toBe("31200");
      // No ceiling configured -> unknown/incremental treated as exceeds -> draft.
      expect(data.status).toBe("draft");
    }
  });

  it("quote with null freight -> both totals null and plan stays draft", async () => {
    const store = harborStore();
    await store.insertQuote(verifiedQuote({ freight_minor: null }));
    const tool = createProposeRecoveryPlanTool({ store, clock, preparer: createFakePreparer(store) });
    const result = await tool.run(ctx, {
      assessment_id: ASSESSMENT_A,
      steps: [{ step_id: "s1", kind: "purchase_bridge", quantity: 600, quote_id: "q-1" }],
      evidence_ids: ["70000000-0000-4000-8000-000000000004"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as {
        status: string;
        gross_commitment_minor: string | null;
        incremental_cost_minor: string | null;
        missing_fields: string[];
      };
      expect(data.gross_commitment_minor).toBeNull();
      expect(data.incremental_cost_minor).toBeNull();
      expect(data.status).toBe("draft");
      expect(data.missing_fields.join(" ")).toContain("s1:freight");
    }
  });

  it("transfer_stock-only plan -> draft with transfer_unverified", async () => {
    const store = harborStore();
    const tool = createProposeRecoveryPlanTool({ store, clock, preparer: createFakePreparer(store) });
    const result = await tool.run(ctx, {
      assessment_id: ASSESSMENT_A,
      steps: [
        {
          step_id: "s1",
          kind: "transfer_stock",
          quantity: 600,
          arrival_by: "2026-10-13T00:00:00Z",
        },
      ],
      evidence_ids: ["70000000-0000-4000-8000-000000000004"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as { status: string; missing_fields: string[] };
      expect(data.status).toBe("draft");
      expect(data.missing_fields).toContain("s1:transfer_unverified");
    }
  });

  it("registry contains exactly the 13 tools and no forbidden verbs", () => {
    const store = harborStore();
    const registry = createToolRegistry({ store, clock, preparer: createFakePreparer(store) });
    const names = [...registry.keys()];
    expect(names).toEqual([...TOOL_NAMES]);
    expect(names.length).toBe(13);
    for (const name of names) {
      expect(name).not.toMatch(
        /(^|_)(accept|purchase|cancel|amend|execute|approve)(_|$)/,
      );
    }
  });

  it("a model tool call to accept_offer -> tool_not_allowed, no state change", async () => {
    const store = harborStore();
    const tools = createToolRegistry({ store, clock, preparer: createFakePreparer(store) });
    const model = scriptedModel([
      toolCallTurn("accept_offer", { offer_id: "x" }),
      toolCallTurn("accept_offer", { offer_id: "y" }),
    ]);
    const step = new FakeStep();
    const outcome = await runPlannerCycle(
      { model, tools, store, clock, step },
      { ...baseCtx, episode: 1, assessmentVersion: 1, cycleId: "cyc-1" },
    );
    expect(outcome.status).toBe("needs_review");
    expect(store.actions.size).toBe(0);
    expect(store.plans.size).toBe(0);
  });
});
