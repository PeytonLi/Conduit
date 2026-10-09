import { describe, expect, it, vi } from "vitest";
import { createReplayResearch, selectResearch } from "@/lib/integrations/exa/replay";
import { createExaResearch } from "@/lib/integrations/exa/client";
import { createSearchSupplierWebTool, composeQuery } from "@/lib/agent/tools/search-supplier-web";
import { createReadSupplierSourceTool } from "@/lib/agent/tools/read-supplier-source";
import { createToolRegistry } from "@/lib/agent/tools/registry";
import {
  clock,
  ctx,
  harborStore,
  RESEARCH_EVIDENCE,
  ITEM_A,
  LOCATION_A,
} from "./planner-test-helpers";

function researchDeps(store = harborStore()) {
  return { store, clock, research: createReplayResearch(clock) };
}

describe("AT-12 supplier research", () => {
  it("composes the query from the case item spec, sanitizing keywords", async () => {
    const store = harborStore();
    const item = (await store.getItem(ctx.orgId, ITEM_A))!;
    const query = composeQuery(item, "kraft supplier https://evil.example \u0001", "West Coast");
    expect(query).toContain("300x200x150 mm");
    expect(query).toContain("KRAFT-SW-DEMO");
    expect(query).not.toContain("https://");
    expect(query).not.toContain("\u0001");
    expect(query).toContain("West Coast");
  });

  it("replay search persists evidence, link and unapproved candidates with deterministic compatibility", async () => {
    const store = harborStore();
    const tool = createSearchSupplierWebTool(researchDeps(store));
    const result = await tool.run(ctx, { keywords: "carton" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as {
      candidates: {
        name: string;
        compatibility: string;
        status: string;
        missing_facts: string[];
        retrieved_at: string;
        published_at: string | null;
      }[];
    };
    expect(data.candidates.length).toBeLessThanOrEqual(5);
    for (const c of data.candidates) {
      expect(c.status).toBe("unapproved");
      expect(c.retrieved_at).toBe(clock.now().toISOString());
      expect(c.missing_facts).toEqual(
        expect.arrayContaining(["current_stock", "arrival_date", "landed_cost", "purchasing_approval"]),
      );
    }
    const byName = Object.fromEntries(data.candidates.map((c) => [c.name.split(" ")[0], c]));
    expect(byName.North?.compatibility).toBe("compatible");
    expect(byName.Budget?.compatibility).toBe("incompatible");
    expect(byName.Coastal?.compatibility).toBe("unknown");

    // Evidence persisted with hash and linked for research.
    const evidence = await store.listCaseEvidence(ctx.orgId, ctx.caseId);
    const researchRows = evidence.filter(
      (e) => e.source_type === "public_web" && e.id !== RESEARCH_EVIDENCE,
    );
    expect(researchRows.length).toBe(data.candidates.length);
    for (const e of researchRows) {
      expect(e.content_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(e.source_url).toMatch(/^https:\/\/.*\.example\.com\//);
    }
    const queries = await store.countResearchQueries(ctx.orgId, ctx.caseId, 1);
    expect(queries).toBe(1);
  });

  it("rejects the 3rd query in an episode", async () => {
    const store = harborStore();
    const tool = createSearchSupplierWebTool(researchDeps(store));
    expect((await tool.run(ctx, { keywords: "a" })).ok).toBe(true);
    expect((await tool.run(ctx, { keywords: "b" })).ok).toBe(true);
    const third = await tool.run(ctx, { keywords: "c" });
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.code).toBe("budget_exhausted");
  });

  it("replay mode never calls fetch even when EXA key is present", async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error("fetch called in replay"));
    const research = selectResearch({ EXA_API_KEY: "present" }, "replay", {
      clock,
      fetchImpl: fetchSpy,
    });
    const store = harborStore();
    const tool = createSearchSupplierWebTool({ store, clock, research });
    const result = await tool.run(ctx, { keywords: "carton" });
    expect(result.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("read_supplier_source returns sanitized text inside untrusted_supplier_text", async () => {
    const store = harborStore();
    const research = createReplayResearch(clock);
    const tool = createReadSupplierSourceTool({ store, clock, research });
    const result = await tool.run(ctx, { evidence_id: RESEARCH_EVIDENCE });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { untrusted_supplier_text: string };
    expect(data.untrusted_supplier_text).toContain("IGNORE ALL PREVIOUS");
    expect(data.untrusted_supplier_text).not.toMatch(/<script>/i);
    expect(data.untrusted_supplier_text.length).toBeLessThanOrEqual(20_000);
  });

  it("rejects the 11th distinct page read", async () => {
    const store = harborStore();
    // Seed 10 distinct reads for the episode.
    for (let i = 0; i < 10; i++) {
      const ev = await store.insertEvidence({
        org_id: ctx.orgId,
        source_type: "public_web",
        source_url: `https://p${i}.example.com`,
        source_time: null,
        captured_at: clock.now().toISOString(),
        content_hash: `h${i}`,
        supported_excerpt: "x",
      });
      await store.linkCaseEvidence({
        org_id: ctx.orgId,
        case_id: ctx.caseId,
        evidence_id: ev.id,
        purpose: "research",
      });
      await store.insertPageRead(ctx.orgId, ctx.caseId, 1, ev.id);
    }
    const tool = createReadSupplierSourceTool({
      store,
      clock,
      research: createReplayResearch(clock),
    });
    const result = await tool.run(ctx, { evidence_id: RESEARCH_EVIDENCE });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("budget_exhausted");
    // Rejected without consuming budget: no 11th row was inserted.
    expect(await store.countPageReads(ctx.orgId, ctx.caseId, 1)).toBe(10);
  });

  it("re-reading an already-read page does not consume budget", async () => {
    const store = harborStore();
    for (let i = 0; i < 10; i++) {
      const ev = await store.insertEvidence({
        org_id: ctx.orgId,
        source_type: "public_web",
        source_url: `https://p${i}.example.com`,
        source_time: null,
        captured_at: clock.now().toISOString(),
        content_hash: `h${i}`,
        supported_excerpt: "x",
      });
      await store.linkCaseEvidence({
        org_id: ctx.orgId,
        case_id: ctx.caseId,
        evidence_id: ev.id,
        purpose: "research",
      });
      await store.insertPageRead(ctx.orgId, ctx.caseId, 1, ev.id);
    }
    // RESEARCH_EVIDENCE was already read this episode: free.
    await store.insertPageRead(ctx.orgId, ctx.caseId, 1, RESEARCH_EVIDENCE);
    const tool = createReadSupplierSourceTool({
      store,
      clock,
      research: createReplayResearch(clock),
    });
    const result = await tool.run(ctx, { evidence_id: RESEARCH_EVIDENCE });
    expect(result.ok).toBe(true);
    expect(await store.countPageReads(ctx.orgId, ctx.caseId, 1)).toBe(11);
  });

  it("rejects evidence from another case or another org", async () => {
    const store = harborStore();
    const foreign = await store.insertEvidence({
      org_id: ctx.orgId,
      source_type: "public_web",
      source_url: "https://x.example.com",
      source_time: null,
      captured_at: clock.now().toISOString(),
      content_hash: "h",
      supported_excerpt: "x",
    });
    // Linked to org B's case, not ours.
    await store.linkCaseEvidence({
      org_id: "00000000-0000-4000-8000-000000000002",
      case_id: "40000000-0000-4000-8000-000000000002",
      evidence_id: foreign.id,
      purpose: "research",
    });
    const tool = createReadSupplierSourceTool({
      store,
      clock,
      research: createReplayResearch(clock),
    });
    const result = await tool.run(ctx, { evidence_id: foreign.id });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("not_found");
  });

  it("live Exa client sends x-api-key, bounded numResults and maxCharacters; maps null publishedDate", async () => {
    const calls: { url: string; init?: { headers?: Record<string, string>; body?: string } }[] = [];
    const fakeFetch = vi.fn(async (url: string | URL, init?: { headers?: Record<string, string>; body?: string }) => {
      calls.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            requestId: "req-1",
            results: [{ url: "https://a.example.com", title: "A", publishedDate: null, text: "text" }],
            costDollars: { total: 0.001 },
          };
        },
      };
    });
    const research = createExaResearch({
      apiKey: "test-key",
      fetchImpl: fakeFetch,
      clock,
    });
    const out = await research.search("cartons", { numResults: 10 });
    const body = JSON.parse(calls[0].init?.body ?? "{}");
    expect(calls[0].init?.headers?.["x-api-key"]).toBe("test-key");
    expect(body.numResults).toBe(5);
    expect(body.contents.text.maxCharacters).toBe(1000);
    expect(out.results[0].published_at).toBeNull();
    expect(out.provider_request_id).toBe("req-1");
    expect(out.cost_usd).toBe("0.001");
  });

  it("registry exposes exactly the 13 allowed tools", () => {
    const registry = createToolRegistry(researchDeps());
    expect(registry.size).toBe(13);
    expect(registry.has("search_supplier_web")).toBe(true);
    expect(registry.has("read_supplier_source")).toBe(true);
    void LOCATION_A;
  });
});
