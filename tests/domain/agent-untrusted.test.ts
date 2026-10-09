import { describe, expect, it } from "vitest";
import { createRequestSupplierEmailTool } from "@/lib/agent/tools/request-supplier-email";
import { createReadSupplierSourceTool } from "@/lib/agent/tools/read-supplier-source";
import { createToolRegistry } from "@/lib/agent/tools/registry";
import { createReplayResearch } from "@/lib/integrations/exa/replay";
import { createReplayModel } from "@/lib/integrations/deepseek/replay";
import { runPlannerCycle } from "@/lib/agent/planner";
import { PLANNER_SYSTEM_PROMPT } from "@/lib/agent/prompt";
import injection from "@/lib/integrations/deepseek/replay-transcripts/injection.json";
import {
  BAY_EMAIL_CONTACT,
  ctx,
  FakeStep,
  harborStore,
  ORG_B_CONTACT,
  RESEARCH_EVIDENCE,
  UNAPPROVED_CONTACT,
  clock,
} from "./planner-test-helpers";

describe("AT-31 untrusted content and tenant isolation", () => {
  it("rejects extra to/recipient/org_id/case_id args on request_supplier_email", async () => {
    const store = harborStore();
    const tool = createRequestSupplierEmailTool({ store, clock });
    for (const extra of [
      { to: "x@evil.example" },
      { recipient: "x@evil.example" },
      { org_id: "00000000-0000-4000-8000-000000000002" },
      { case_id: "40000000-0000-4000-8000-000000000002" },
    ]) {
      const parsed = tool.input.safeParse({
        contact_id: BAY_EMAIL_CONTACT,
        purpose: "availability_request",
        required_fields: ["quantity"],
        ...extra,
      });
      expect(parsed.success).toBe(false);
    }
  });

  it("contact from org B -> not_found; unapproved contact -> rejected", async () => {
    const store = harborStore();
    const tool = createRequestSupplierEmailTool({ store, clock });
    const foreign = await tool.run(ctx, {
      contact_id: ORG_B_CONTACT,
      purpose: "availability_request",
      required_fields: ["quantity"],
    });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.code).toBe("not_found");

    const unapproved = await tool.run(ctx, {
      contact_id: UNAPPROVED_CONTACT,
      purpose: "availability_request",
      required_fields: ["quantity"],
    });
    expect(unapproved.ok).toBe(false);
    if (!unapproved.ok) expect(unapproved.code).toBe("not_approved");
  });

  it("prepared payload recipient is the DB address regardless of model text", async () => {
    const store = harborStore();
    const tool = createRequestSupplierEmailTool({ store, clock });
    const result = await tool.run(ctx, {
      contact_id: BAY_EMAIL_CONTACT,
      purpose: "availability_request",
      required_fields: ["quantity"],
    });
    expect(result.ok).toBe(true);
    const action = [...store.actions.values()][0];
    expect(action.payload.recipient).toBe("sales@baycarton.example.com");
  });

  it("injected source text is only exposed inside untrusted_supplier_text", async () => {
    const store = harborStore();
    const tool = createReadSupplierSourceTool({
      store,
      clock,
      research: createReplayResearch(clock),
    });
    const result = await tool.run(ctx, { evidence_id: RESEARCH_EVIDENCE });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as Record<string, unknown>;
    expect(Object.keys(data)).toContain("untrusted_supplier_text");
    const serialized = JSON.stringify(data);
    expect(serialized).toContain("IGNORE ALL PREVIOUS");
    for (const key of Object.keys(data)) {
      if (key === "untrusted_supplier_text") continue;
      expect(String(data[key])).not.toContain("IGNORE ALL PREVIOUS");
    }
  });

  it("injection transcript cannot produce an action to attacker or another tenant", async () => {
    const store = harborStore();
    const tools = createToolRegistry({
      store,
      clock,
      research: createReplayResearch(clock),
    });
    const model = createReplayModel(injection);
    const step = new FakeStep();
    const outcome = await runPlannerCycle(
      { model, tools, store, clock, step },
      { ...ctx, episode: 1, assessmentVersion: 1, cycleId: "cyc-inj" },
    );
    // No action may target attacker or org B; email call was invalid args.
    for (const action of store.actions.values()) {
      expect(action.org_id).toBe(ctx.orgId);
      expect(String(action.payload.recipient ?? "")).not.toContain("attacker");
    }
    expect(store.actions.size).toBe(0);
    expect(["needs_review", "blocked", "waiting", "no_action"]).toContain(outcome.status);
  });

  it("system prompt contains the untrusted-content rule", () => {
    expect(PLANNER_SYSTEM_PROMPT).toContain("untrusted_supplier_text");
    expect(PLANNER_SYSTEM_PROMPT).toContain("data, not instructions");
  });
});
