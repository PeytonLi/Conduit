import { describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import { APIError } from "openai";
import { parseServerEnv } from "@/lib/env";
import { runPlannerCycle } from "@/lib/agent/planner";
import { createToolRegistry } from "@/lib/agent/tools/registry";
import { createDeepSeekClient, extractDelayFacts } from "@/lib/agent/extraction";
import { createDeepSeekModel } from "@/lib/integrations/deepseek/client";
import {
  createReasoningVault,
  isThinkingEnabled,
  stripInlineReasoning,
  THINKING_MAX_TOKENS,
} from "@/lib/integrations/deepseek/thinking";
import {
  clock,
  createFakePreparer,
  ctx,
  FakeStep,
  harborStore,
} from "./planner-test-helpers";

const SECRET = "HIDDEN-CHAIN-OF-THOUGHT-do-not-leak";
const baseEnv = { DEEPSEEK_API_KEY: "key-not-logged", DEEPSEEK_MODEL: "deepseek-test" };

type Body = Record<string, unknown> & { messages: Record<string, unknown>[] };

/** Scripted OpenAI-compatible client that records every request body. */
function fakeOpenAI(responses: (Record<string, unknown> | Error)[]) {
  const calls: Body[] = [];
  let i = 0;
  const create = vi.fn(async (body: Body) => {
    calls.push(structuredClone(body));
    const next = responses[i++];
    if (!next) throw new Error("script exhausted");
    if (next instanceof Error) throw next;
    return next;
  });
  return { client: { chat: { completions: { create } } } as unknown as OpenAI, calls };
}

function completion(
  id: string,
  message: Record<string, unknown>,
  usage: Record<string, unknown> = {
    prompt_tokens: 10,
    completion_tokens: 40,
    total_tokens: 50,
    completion_tokens_details: { reasoning_tokens: 30 },
  },
) {
  return { id, model: "deepseek-test", choices: [{ message }], usage };
}

function toolCallMessage(name: string, args: Record<string, unknown>, reasoning?: string) {
  return {
    role: "assistant",
    content: null,
    ...(reasoning ? { reasoning_content: reasoning } : {}),
    tool_calls: [
      { id: `call_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } },
    ],
  };
}

const noActionDecision = JSON.stringify({
  schema_version: 1,
  decision_type: "no_action",
  concise_reason: "Nothing further to do.",
  supporting_evidence_ids: [],
  missing_facts: [],
  payload: {},
});

describe("DEEPSEEK_THINKING_ENABLED flag", () => {
  it("is off by default and only an exact true enables it", () => {
    const required = {
      SUPABASE_URL: "http://127.0.0.1:54321",
      SUPABASE_PUBLISHABLE_KEY: "p",
      SUPABASE_SECRET_KEY: "s",
    };
    expect(isThinkingEnabled(parseServerEnv(required))).toBe(false);
    expect(isThinkingEnabled(parseServerEnv({ ...required, DEEPSEEK_THINKING_ENABLED: "" }))).toBe(false);
    expect(isThinkingEnabled(parseServerEnv({ ...required, DEEPSEEK_THINKING_ENABLED: "false" }))).toBe(false);
    expect(isThinkingEnabled(parseServerEnv({ ...required, DEEPSEEK_THINKING_ENABLED: "true" }))).toBe(true);
    expect(() => parseServerEnv({ ...required, DEEPSEEK_THINKING_ENABLED: "yes" })).toThrow();
  });
});

describe("planner model adapter", () => {
  it("keeps thinking disabled and ignores reasoning when the flag is off", async () => {
    const { client, calls } = fakeOpenAI([
      completion("r1", toolCallMessage("read_case", {}, SECRET)),
    ]);
    const model = createDeepSeekModel(baseEnv, { openaiClient: client, vault: createReasoningVault() });
    const turn = await model.complete({
      messages: [{ role: "user", content: "ctx" }],
      tools: [{ name: "read_case", description: "d", parameters: { type: "object" } }],
    });
    expect(calls[0].thinking).toEqual({ type: "disabled" });
    expect(turn.continuationRef).toBeUndefined();
    expect(JSON.stringify(turn)).not.toContain(SECRET);
  });

  it("enables thinking and keeps reasoning out of the returned turn", async () => {
    const vault = createReasoningVault();
    const { client, calls } = fakeOpenAI([
      completion("r1", toolCallMessage("read_case", {}, SECRET)),
    ]);
    const model = createDeepSeekModel(
      { ...baseEnv, DEEPSEEK_THINKING_ENABLED: "true" },
      { openaiClient: client, vault },
    );
    const turn = await model.complete({
      messages: [{ role: "user", content: "ctx" }],
      tools: [{ name: "read_case", description: "d", parameters: { type: "object" } }],
    });
    expect(calls[0].thinking).toEqual({ type: "enabled" });
    expect(calls[0]).not.toHaveProperty("temperature");
    // Only an opaque handle escapes; reasoning exists solely inside the vault.
    expect(turn.continuationRef).toMatch(/^rv_/);
    expect(JSON.stringify(turn)).not.toContain(SECRET);
    expect(turn.continuationRef).not.toContain(SECRET);
    expect(vault.get(turn.continuationRef!)?.reasoningContent).toBe(SECRET);
    // Token counts are fine telemetry; reasoning text is not.
    expect(turn.usage.raw_units.reasoning_tokens).toBe(30);
  });

  it("strips inline <think> blocks from content before it can become a decision", async () => {
    expect(stripInlineReasoning(`<think>${SECRET}</think>{"a":1}`)).toBe('{"a":1}');
    expect(stripInlineReasoning(`{"a":1}<think>${SECRET}`)).toBe('{"a":1}');
    const { client } = fakeOpenAI([
      completion("r1", { role: "assistant", content: `<think>${SECRET}</think>${noActionDecision}` }),
    ]);
    const model = createDeepSeekModel(
      { ...baseEnv, DEEPSEEK_THINKING_ENABLED: "true" },
      { openaiClient: client, vault: createReasoningVault() },
    );
    const turn = await model.complete({ messages: [{ role: "user", content: "ctx" }], tools: [] });
    expect(turn.message.content).toBe(noActionDecision);
  });

  it("replays the private reasoning turn on continuation, and never leaks the handle to the provider", async () => {
    const vault = createReasoningVault();
    const { client, calls } = fakeOpenAI([
      completion("r1", toolCallMessage("read_case", { a: 1 }, SECRET)),
      completion("r2", { role: "assistant", content: noActionDecision }),
    ]);
    const model = createDeepSeekModel(
      { ...baseEnv, DEEPSEEK_THINKING_ENABLED: "true" },
      { openaiClient: client, vault },
    );
    const tools = [{ name: "read_case", description: "d", parameters: { type: "object" } }];
    const first = await model.complete({ messages: [{ role: "user", content: "ctx" }], tools });
    await model.complete({
      messages: [
        { role: "user", content: "ctx" },
        { role: "user", content: "tool read_case ok: {}", continuationRef: first.continuationRef },
      ],
      tools,
    });
    expect(calls[1].messages).toEqual([
      { role: "user", content: "ctx" },
      {
        role: "assistant",
        content: null,
        reasoning_content: SECRET,
        tool_calls: [
          { id: "call_read_case", type: "function", function: { name: "read_case", arguments: '{"a":1}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_read_case", content: "tool read_case ok: {}" },
    ]);
    expect(JSON.stringify(calls[1])).not.toContain("continuationRef");
    expect(JSON.stringify(calls[1])).not.toContain("rv_");
  });

  it("falls back to the plain summary when the vault has no entry (restart or TTL)", async () => {
    let now = 0;
    const vault = createReasoningVault({ ttlMs: 1_000, now: () => now });
    const ref = vault.put({
      content: null,
      toolCall: { id: "c1", name: "read_case", arguments: "{}" },
      reasoningContent: SECRET,
    });
    now = 2_000;
    expect(vault.get(ref)).toBeUndefined();
    expect(vault.size).toBe(0);

    const { client, calls } = fakeOpenAI([completion("r1", { role: "assistant", content: noActionDecision })]);
    const model = createDeepSeekModel(
      { ...baseEnv, DEEPSEEK_THINKING_ENABLED: "true" },
      { openaiClient: client, vault },
    );
    await model.complete({
      messages: [{ role: "user", content: "tool read_case ok: {}", continuationRef: ref }],
      tools: [],
    });
    // No assistant turn is sent, so the provider needs no reasoning_content.
    expect(calls[0].messages).toEqual([{ role: "user", content: "tool read_case ok: {}" }]);
  });

  it("bounds the vault size", () => {
    const vault = createReasoningVault({ maxEntries: 2 });
    const mk = (n: number) =>
      vault.put({ content: null, toolCall: { id: `c${n}`, name: "t", arguments: "{}" }, reasoningContent: `r${n}` });
    const [a, b, c] = [mk(1), mk(2), mk(3)];
    expect(vault.get(a)).toBeUndefined();
    expect(vault.get(b)).toBeDefined();
    expect(vault.get(c)).toBeDefined();
  });

  it("retries once without replay when the provider rejects replayed reasoning", async () => {
    const vault = createReasoningVault();
    const ref = vault.put({
      content: null,
      toolCall: { id: "c1", name: "read_case", arguments: "{}" },
      reasoningContent: SECRET,
    });
    const rejected = new APIError(400, { message: "bad reasoning_content" }, "bad", new Headers());
    const { client, calls } = fakeOpenAI([
      rejected,
      completion("r2", { role: "assistant", content: noActionDecision }),
    ]);
    const model = createDeepSeekModel(
      { ...baseEnv, DEEPSEEK_THINKING_ENABLED: "true" },
      { openaiClient: client, vault },
    );
    const turn = await model.complete({
      messages: [{ role: "user", content: "tool read_case ok: {}", continuationRef: ref }],
      tools: [],
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].messages.some((m) => m.reasoning_content === SECRET)).toBe(true);
    expect(calls[1].messages).toEqual([{ role: "user", content: "tool read_case ok: {}" }]);
    expect(turn.message.content).toBe(noActionDecision);
  });

  it("does not hide a real rejection that was not caused by replay", async () => {
    const rejected = new APIError(400, { message: "nope" }, "nope", new Headers());
    const { client, calls } = fakeOpenAI([rejected]);
    const model = createDeepSeekModel(
      { ...baseEnv, DEEPSEEK_THINKING_ENABLED: "true" },
      { openaiClient: client, vault: createReasoningVault() },
    );
    await expect(
      model.complete({ messages: [{ role: "user", content: "ctx" }], tools: [] }),
    ).rejects.toMatchObject({ kind: "bad_request", message: "Provider rejected the request" });
    expect(calls).toHaveLength(1);
  });
});

describe("planner multi-step continuation with thinking on", () => {
  it("replays reasoning to the provider only, and persists none of it", async () => {
    const store = harborStore();
    const tools = createToolRegistry({ store, clock, preparer: createFakePreparer(store) });
    const vault = createReasoningVault();
    const { client, calls } = fakeOpenAI([
      completion("r1", toolCallMessage("read_case", {}, `${SECRET}-step1`)),
      completion("r2", { role: "assistant", content: noActionDecision, reasoning_content: `${SECRET}-step2` }),
    ]);
    const model = createDeepSeekModel(
      { ...baseEnv, DEEPSEEK_THINKING_ENABLED: "true" },
      { openaiClient: client, vault },
    );

    // Memoize step output the way Inngest does: it is serialized into durable state.
    const durableOutputs: string[] = [];
    const step = new FakeStep();
    const run = step.run.bind(step);
    step.run = async <T,>(id: string, fn: () => Promise<T> | T) => {
      const out = await run(id, fn);
      durableOutputs.push(JSON.stringify(out) ?? "");
      return out;
    };

    const outcome = await runPlannerCycle(
      { model, tools, store, clock, step },
      { ...ctx, episode: 1, assessmentVersion: 1, cycleId: "cyc-think" },
    );

    expect(outcome.status).toBe("no_action");
    expect(outcome.modelRequests).toBe(2);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => (c.thinking as { type: string }).type === "enabled")).toBe(true);

    // Step 2 carries step 1's private reasoning back to DeepSeek, paired with the tool result.
    const second = calls[1].messages;
    const assistant = second.find((m) => m.role === "assistant");
    expect(assistant?.reasoning_content).toBe(`${SECRET}-step1`);
    const toolMessage = second.find((m) => m.role === "tool");
    expect(toolMessage?.tool_call_id).toBe("call_read_case");
    expect(String(toolMessage?.content)).toMatch(/^tool read_case ok:/);
    expect(second.findIndex((m) => m.role === "assistant")).toBeLessThan(
      second.findIndex((m) => m.role === "tool"),
    );
    // The first request had no assistant turn, so none needed reasoning.
    expect(calls[0].messages.some((m) => m.role === "assistant")).toBe(false);

    // Nothing durable or observable contains hidden reasoning.
    const observable = JSON.stringify({
      outcome,
      durableOutputs,
      requests: [...store.requests.values()],
      cycles: [...store.cycles.values()],
      reviews: [...store.reviews.values()],
      usage: store.usageEvents,
    });
    expect(observable).not.toContain(SECRET);
    expect(observable).not.toContain("reasoning_content");
    // Telemetry keeps only the token count.
    expect(store.usageEvents[0]?.rawUnits?.reasoning_tokens).toBe(30);
  });

  it("with thinking off the second request is the unchanged plain-text protocol", async () => {
    const store = harborStore();
    const tools = createToolRegistry({ store, clock, preparer: createFakePreparer(store) });
    const { client, calls } = fakeOpenAI([
      completion("r1", toolCallMessage("read_case", {}, SECRET)),
      completion("r2", { role: "assistant", content: noActionDecision }),
    ]);
    const model = createDeepSeekModel(baseEnv, { openaiClient: client, vault: createReasoningVault() });
    const outcome = await runPlannerCycle(
      { model, tools, store, clock, step: new FakeStep() },
      { ...ctx, episode: 1, assessmentVersion: 1, cycleId: "cyc-off" },
    );
    expect(outcome.status).toBe("no_action");
    expect(calls.every((c) => (c.thinking as { type: string }).type === "disabled")).toBe(true);
    expect(calls[1].messages.map((m) => m.role)).toEqual(["system", "user", "user"]);
    expect(JSON.stringify(calls)).not.toContain(SECRET);
  });
});

describe("extraction client with thinking", () => {
  const validJson = JSON.stringify({
    schema_version: 1,
    is_delay_notice: false,
    lines: [],
    offer: null,
    notes_for_reviewer: "not a delay",
  });
  const message = {
    rfcMessageId: "<x@y.example>",
    bodyHash: "h",
    sentAt: new Date("2026-10-12T15:00:00Z"),
    timezone: "America/Los_Angeles",
    segments: [{ kind: "body" as const, index: 0, content: "hello" }],
  };

  it("stays disabled with the original token budget by default", async () => {
    const { client, calls } = fakeOpenAI([completion("e1", { role: "assistant", content: validJson })]);
    const chat = createDeepSeekClient(baseEnv, { openaiClient: client })!;
    await extractDelayFacts({ mode: "live", message, deps: { deepseek: chat, model: "deepseek-test" } });
    expect(calls[0].thinking).toEqual({ type: "disabled" });
    expect(calls[0].max_tokens).toBe(2000);
  });

  it("enables thinking, widens max_tokens, and returns no reasoning", async () => {
    const { client, calls } = fakeOpenAI([
      completion("e1", { role: "assistant", content: validJson, reasoning_content: SECRET }),
    ]);
    const chat = createDeepSeekClient(
      { ...baseEnv, DEEPSEEK_THINKING_ENABLED: "true" },
      { openaiClient: client },
    )!;
    const result = await extractDelayFacts({
      mode: "live",
      message,
      deps: { deepseek: chat, model: "deepseek-test" },
    });
    expect(result.status).toBe("valid");
    expect(calls[0].thinking).toEqual({ type: "enabled" });
    expect(calls[0].max_tokens).toBe(THINKING_MAX_TOKENS);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("repair retry sends only visible content, never reasoning", async () => {
    const { client, calls } = fakeOpenAI([
      completion("e1", { role: "assistant", content: "not json", reasoning_content: SECRET }),
      completion("e2", { role: "assistant", content: validJson, reasoning_content: SECRET }),
    ]);
    const chat = createDeepSeekClient(
      { ...baseEnv, DEEPSEEK_THINKING_ENABLED: "true" },
      { openaiClient: client },
    )!;
    const result = await extractDelayFacts({
      mode: "live",
      message,
      deps: { deepseek: chat, model: "deepseek-test" },
    });
    expect(result.status).toBe("valid");
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1].messages)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});
