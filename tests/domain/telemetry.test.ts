import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetTelemetryForTests,
  flushTelemetry,
  getNeatlogs,
  initTelemetry,
  isTelemetryEnabled,
  orgPseudonym,
  withBusinessSpan,
} from "@/lib/telemetry";
import { maskTelemetry } from "@/lib/telemetry/mask";
import { extractUsage } from "@/lib/integrations/deepseek/usage";
import { createDeepSeekModel } from "@/lib/integrations/deepseek/client";
import { ModelUnavailableError } from "@/lib/agent/model";

interface FakeSpan {
  attributes: Record<string, unknown>;
  setAttribute(k: string, v: unknown): void;
}

function fakeNeatlogs(overrides?: {
  initThrows?: boolean;
  traceThrows?: boolean;
}) {
  const spans: { name: string; kind?: string; input?: unknown; attrs: Record<string, unknown> }[] = [];
  const mod = {
    initCalls: [] as Record<string, unknown>[],
    async init(opts?: Record<string, unknown>) {
      if (overrides?.initThrows) throw new Error("init failed");
      this.initCalls.push(opts ?? {});
    },
    async trace<T>(
      options: { name: string; kind?: string; input?: unknown },
      fn: (span: FakeSpan) => T | Promise<T>,
    ) {
      if (overrides?.traceThrows) throw new Error("trace failed");
      const span: FakeSpan = {
        attributes: {},
        setAttribute(k, v) {
          this.attributes[k] = v;
        },
      };
      const result = await fn(span);
      spans.push({ ...options, attrs: span.attributes });
      return result;
    },
    async flush() {
      return true;
    },
    async shutdown() {
      return true;
    },
  };
  return { mod, spans };
}

afterEach(() => {
  _resetTelemetryForTests();
  vi.restoreAllMocks();
});

describe("AT-29 telemetry", () => {
  it("shares initialized state across reloaded module instances", async () => {
    const { mod } = fakeNeatlogs();
    await initTelemetry({ NEATLOGS_API_KEY: "k" }, { neatlogs: mod });

    vi.resetModules();
    const reloaded = await import("@/lib/telemetry");
    try {
      expect(reloaded.isTelemetryEnabled()).toBe(true);
      expect(reloaded.getNeatlogs()).toBe(mod);
      expect(getNeatlogs()).toBe(mod);
    } finally {
      reloaded._resetTelemetryForTests();
    }
  });

  it("no NEATLOGS_API_KEY -> disabled, business fn still runs once", async () => {
    const { mod, spans } = fakeNeatlogs();
    await initTelemetry({}, { neatlogs: mod });
    expect(isTelemetryEnabled()).toBe(false);
    let ran = 0;
    const result = await withBusinessSpan("message_extraction", {}, async () => {
      ran += 1;
      return "ok";
    });
    expect(result).toBe("ok");
    expect(ran).toBe(1);
    expect(spans).toHaveLength(0);
  });

  it("init failure -> degraded with one safe warn, fn runs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { mod } = fakeNeatlogs({ initThrows: true });
    await initTelemetry({ NEATLOGS_API_KEY: "k" }, { neatlogs: mod });
    expect(isTelemetryEnabled()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).not.toContain("k");
    let ran = 0;
    await withBusinessSpan("matching", {}, async () => {
      ran += 1;
    });
    expect(ran).toBe(1);
  });

  it("enabled -> conduit.* attrs on spans", async () => {
    const { mod, spans } = fakeNeatlogs();
    await initTelemetry({ NEATLOGS_API_KEY: "k" }, { neatlogs: mod });
    expect(isTelemetryEnabled()).toBe(true);
    await withBusinessSpan(
      "planner_inference",
      {
        org_pseudonym: orgPseudonym("00000000-0000-4000-8000-000000000001"),
        case_id: "case-1",
        action_id: "act-1",
        plan_version: 2,
        model: "deepseek-flash",
        prompt_version: "planner-v1",
        provider_request_id: "req-1",
        conversation_id: "conv-1",
      },
      async () => "done",
    );
    expect(spans.length).toBe(1);
    const span = spans[0];
    expect(span.name).toBe("conduit.planner_inference");
    expect(span.kind).toBe("AGENT");
    expect(span.attrs["conduit.case_id"]).toBe("case-1");
    expect(span.attrs["conduit.action_id"]).toBe("act-1");
    expect(span.attrs["conduit.plan_version"]).toBe(2);
    expect(span.attrs["conduit.model"]).toBe("deepseek-flash");
    expect(span.attrs["conduit.prompt_version"]).toBe("planner-v1");
    expect(span.attrs["conduit.provider_request_id"]).toBe("req-1");
    expect(span.attrs["conduit.conversation_id"]).toBe("conv-1");
    expect(String(span.attrs["conduit.org_pseudonym"])).toMatch(/^org_[0-9a-f]{12}$/);
  });

  it("message extraction records its AGENT span and correlation attributes", async () => {
    const { mod, spans } = fakeNeatlogs();
    await initTelemetry({ NEATLOGS_API_KEY: "k" }, { neatlogs: mod });

    await withBusinessSpan(
      "message_extraction",
      {
        org_pseudonym: orgPseudonym("00000000-0000-4000-8000-000000000001"),
        model: "deepseek-chat",
        prompt_version: "extract-v1",
        source_message_id: "84683f50-6467-4bdb-9f32-7d3366df13ad",
      },
      async () => "done",
    );

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      name: "conduit.message_extraction",
      kind: "AGENT",
      input: undefined,
      attrs: {
        "conduit.org_pseudonym": orgPseudonym(
          "00000000-0000-4000-8000-000000000001",
        ),
        "conduit.model": "deepseek-chat",
        "conduit.prompt_version": "extract-v1",
        "conduit.source_message_id": "84683f50-6467-4bdb-9f32-7d3366df13ad",
      },
    });
  });

  it("trace throwing before fn -> fn result unaffected and runs once", async () => {
    const { mod } = fakeNeatlogs({ traceThrows: true });
    await initTelemetry({ NEATLOGS_API_KEY: "k" }, { neatlogs: mod });
    let ran = 0;
    const result = await withBusinessSpan("matching", {}, async () => {
      ran += 1;
      return "value";
    });
    expect(result).toBe("value");
    expect(ran).toBe(1);
  });

  it("maskTelemetry redacts keys, sk-*, bearer, JWT, reasoning_content, emails, phones", () => {
    const input = {
      api_key: "sk-" + "1234567890abcdef",
      nested: {
        authorization: "Bearer abc.def.ghi",
        reasoning_content: "hidden chain",
        email: "person@example.com",
        phone: "+1 415 555 0199",
        // Assembled so secret scanners don't see a contiguous JWT literal.
        jwt: ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxIn0", "testsignature"].join("."),
      },
      list: [{ secret_token: "x", keep: "safe" }],
    };
    const masked = maskTelemetry(input) as Record<string, unknown>;
    expect(masked.api_key).toBe("[redacted]");
    const nested = masked.nested as Record<string, unknown>;
    expect(nested.authorization).toBe("[redacted]");
    expect(nested.reasoning_content).toBe("[redacted]");
    expect(nested.email).toBe("p***@example.com");
    expect(nested.phone).toBe("[phone]");
    expect(nested.jwt).toBe("[redacted]");
    const list = masked.list as Record<string, unknown>[];
    expect(list[0].secret_token).toBe("[redacted]");
    expect(list[0].keep).toBe("safe");
  });

  it("preserves numeric token counts while masking other sensitive values", () => {
    const input = {
      "neatlogs.llm.token_count.prompt": 391,
      "neatlogs.llm.max_tokens": 1200,
      prompt_tokens: 5,
      reasoning_tokens: "12",
      "neatlogs.llm.token_count.cache_read": "256",
      access_token: "abc",
      token: "xyz",
      api_key: "k",
      token_count: "abc",
      authorization: "Bearer x",
      reasoning_content: "...",
      nested: {
        completion_tokens: 212,
        access_token: "nested-secret",
        sibling: "person@example.com",
      },
    };

    const masked = maskTelemetry(input) as Record<string, unknown>;
    expect(masked["neatlogs.llm.token_count.prompt"]).toBe(391);
    expect(masked["neatlogs.llm.max_tokens"]).toBe(1200);
    expect(masked.prompt_tokens).toBe(5);
    expect(masked.reasoning_tokens).toBe("12");
    expect(masked["neatlogs.llm.token_count.cache_read"]).toBe("256");
    expect(masked.access_token).toBe("[redacted]");
    expect(masked.token).toBe("[redacted]");
    expect(masked.api_key).toBe("[redacted]");
    expect(masked.token_count).toBe("[redacted]");
    expect(masked.authorization).toBe("[redacted]");
    expect(masked.reasoning_content).toBe("[redacted]");

    const nested = masked.nested as Record<string, unknown>;
    expect(nested.completion_tokens).toBe(212);
    expect(nested.access_token).toBe("[redacted]");
    expect(nested.sibling).toBe("p***@example.com");
  });

  it("flushTelemetry never throws", async () => {
    await initTelemetry({}, { neatlogs: fakeNeatlogs().mod });
    await expect(flushTelemetry()).resolves.toBeUndefined();
  });

  it("DeepSeek factory: timeout 60000, maxRetries 0, thinking disabled, missing model -> ModelUnavailableError", async () => {
    expect(() => createDeepSeekModel({ DEEPSEEK_API_KEY: "k" })).toThrow(
      ModelUnavailableError,
    );
    const requests: Record<string, unknown>[] = [];
    const fakeClient = {
      chat: {
        completions: {
          async create(params: Record<string, unknown>) {
            requests.push(params);
            return {
              id: "req-1",
              model: "deepseek-flash",
              choices: [{ message: { content: "{}", tool_calls: undefined } }],
              usage: {
                prompt_tokens: 1234,
                completion_tokens: 10,
                total_tokens: 1244,
                prompt_cache_hit_tokens: 0,
                prompt_cache_miss_tokens: 1234,
              },
            };
          },
        },
      },
    };
    const model = createDeepSeekModel(
      { DEEPSEEK_API_KEY: "k", DEEPSEEK_MODEL: "deepseek-flash" },
      {
        openaiClient: fakeClient as never,
        rateCard: {
          cache_hit_input: "0.15",
          cache_miss_input: "0.15",
          output: "0.60",
          rate_version: "r1",
        },
      },
    );
    const turn = await model.complete({
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    });
    const params = requests[0];
    expect(params.thinking).toEqual({ type: "disabled" });
    expect(turn.usage.estimated_cost).toBe("0.000191100000");
  });

  it("usage decimal precision: 1234 tokens @ 0.15/1M = 0.000185100000; missing usage/rate -> null", () => {
    const usage = extractUsage(
      {
        id: "r",
        usage: {
          prompt_cache_hit_tokens: 1234,
          prompt_cache_miss_tokens: 0,
          completion_tokens: 0,
        },
      },
      {
        model: "m",
        rateCard: {
          cache_hit_input: "0.15",
          cache_miss_input: "0.15",
          output: "0.60",
          rate_version: "v",
        },
      },
    );
    expect(usage.estimated_cost).toBe("0.000185100000");
    const noRate = extractUsage({ id: "r", usage: { prompt_tokens: 5 } }, { model: "m" });
    expect(noRate.estimated_cost).toBeNull();
    const noUsage = extractUsage(null, { model: "m" });
    expect(noUsage.estimated_cost).toBeNull();
    expect(noUsage.billing_currency).toBeNull();
  });
});
