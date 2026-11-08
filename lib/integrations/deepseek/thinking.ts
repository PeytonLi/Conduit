import { randomUUID } from "node:crypto";

/**
 * DeepSeek thinking mode support.
 *
 * Thinking is OFF unless DEEPSEEK_THINKING_ENABLED is exactly "true". Hidden
 * reasoning (`reasoning_content`) is provider-private: it may only live in the
 * process-local ReasoningVault below and be echoed back to DeepSeek itself.
 * It must never reach model turns returned to callers, durable step output,
 * the database, logs, telemetry, browser payloads, or case explanations.
 */

export const THINKING_ENABLED_ENV = "DEEPSEEK_THINKING_ENABLED";

/**
 * In thinking mode `max_tokens` also covers the chain of thought, so the
 * small non-thinking budgets (e.g. 2000 for extraction) would truncate the
 * visible answer. Callers use max(requested, THINKING_MAX_TOKENS).
 */
export const THINKING_MAX_TOKENS = 16_000;

export function isThinkingEnabled(
  env: { DEEPSEEK_THINKING_ENABLED?: string | undefined } | undefined,
): boolean {
  return env?.DEEPSEEK_THINKING_ENABLED?.trim().toLowerCase() === "true";
}

export function thinkingParam(enabled: boolean): { type: "enabled" | "disabled" } {
  return { type: enabled ? "enabled" : "disabled" };
}

/**
 * Some OpenAI-compatible gateways inline reasoning into `content` as
 * <think>…</think>. Strip it (including an unterminated trailing block) so it
 * cannot be parsed as, or persisted inside, a decision or explanation.
 */
export function stripInlineReasoning(content: string): string {
  return content
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "")
    .replace(/<think(?:ing)?>[\s\S]*$/i, "")
    .trim();
}

/** The assistant turn DeepSeek needs echoed back when a tools request continues. */
export interface PrivateAssistantTurn {
  content: string | null;
  /** The single tool call the planner executed (side effects are serial). */
  toolCall: { id: string; name: string; arguments: string };
  reasoningContent: string;
}

export interface ReasoningVault {
  /** Stores a turn and returns an opaque, non-derivable handle. */
  put(turn: PrivateAssistantTurn): string;
  get(ref: string): PrivateAssistantTurn | undefined;
  readonly size: number;
}

export interface ReasoningVaultOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

/**
 * Process-memory only, short-lived, bounded. Never persisted, so there is
 * nothing to encrypt at rest; a miss (restart, other instance, TTL) is safe
 * because callers fall back to a plain-text tool summary with no reasoning.
 */
export function createReasoningVault(options: ReasoningVaultOptions = {}): ReasoningVault {
  const ttlMs = options.ttlMs ?? 15 * 60_000;
  const maxEntries = options.maxEntries ?? 256;
  const now = options.now ?? Date.now;
  const entries = new Map<string, { turn: PrivateAssistantTurn; expiresAt: number }>();

  const sweep = () => {
    const t = now();
    for (const [ref, entry] of entries) {
      if (entry.expiresAt <= t) entries.delete(ref);
    }
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  };

  return {
    put(turn) {
      const ref = `rv_${randomUUID()}`;
      entries.set(ref, { turn, expiresAt: now() + ttlMs });
      sweep();
      return ref;
    },
    get(ref) {
      sweep();
      return entries.get(ref)?.turn;
    },
    get size() {
      sweep();
      return entries.size;
    },
  };
}

/** Shared by every model instance in this process (instances are rebuilt per run). */
export const sharedReasoningVault: ReasoningVault = createReasoningVault();
