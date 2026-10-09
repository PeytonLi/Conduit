import type { UsageRecord } from "@/lib/agent/model";

export interface DeepSeekRateCard {
  /** Decimal USD per 1M tokens. */
  cache_hit_input: string;
  cache_miss_input: string;
  output: string;
  rate_version: string;
}

const SCALE = 1_000_000_000_000n; // 10^12 fractional digits
const PER_MILLION = 1_000_000n;

function parseDecimalToScaled(value: string): bigint {
  const trimmed = value.trim();
  const negative = trimmed.startsWith("-");
  const body = negative ? trimmed.slice(1) : trimmed;
  const [intPart, fracPart = ""] = body.split(".");
  const fracScaled = (fracPart + "0".repeat(12)).slice(0, 12);
  const scaled = BigInt(intPart || "0") * SCALE + BigInt(fracScaled || "0");
  return negative ? -scaled : scaled;
}

function scaledToDecimalString(scaled: bigint): string {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const intPart = abs / SCALE;
  const frac = (abs % SCALE).toString().padStart(12, "0");
  return `${negative ? "-" : ""}${intPart}.${frac}`;
}

interface UsageShape {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
}

/**
 * Extract usage + cost from a chat completion response. Cost is computed with
 * BigInt fixed-point (12 fractional digits, numeric(24,12)) and only when a
 * rate card is supplied AND usage is present; otherwise estimated_cost is null.
 */
export function extractUsage(
  response: { id?: string; model?: string; usage?: UsageShape | null } | null | undefined,
  opts: { model: string; rateCard?: DeepSeekRateCard },
): UsageRecord {
  const usage = response?.usage ?? null;
  const raw_units: Record<string, number> = {};
  if (usage) {
    if (usage.prompt_tokens !== undefined) raw_units.prompt_tokens = usage.prompt_tokens;
    if (usage.completion_tokens !== undefined)
      raw_units.completion_tokens = usage.completion_tokens;
    if (usage.total_tokens !== undefined) raw_units.total_tokens = usage.total_tokens;
    if (usage.prompt_cache_hit_tokens !== undefined)
      raw_units.prompt_cache_hit_tokens = usage.prompt_cache_hit_tokens;
    if (usage.prompt_cache_miss_tokens !== undefined)
      raw_units.prompt_cache_miss_tokens = usage.prompt_cache_miss_tokens;
    const reasoning = usage.completion_tokens_details?.reasoning_tokens;
    if (reasoning !== undefined) raw_units.reasoning_tokens = reasoning;
  }

  let estimated_cost: string | null = null;
  if (usage && opts.rateCard) {
    const card = opts.rateCard;
    const hit = BigInt(usage.prompt_cache_hit_tokens ?? 0);
    const miss = BigInt(
      usage.prompt_cache_miss_tokens ?? usage.prompt_tokens ?? 0,
    );
    const output = BigInt(usage.completion_tokens ?? 0);
    const scaled =
      (hit * parseDecimalToScaled(card.cache_hit_input) +
        miss * parseDecimalToScaled(card.cache_miss_input) +
        output * parseDecimalToScaled(card.output)) /
      PER_MILLION;
    estimated_cost = scaledToDecimalString(scaled);
  }

  return {
    provider: "deepseek",
    request_id: response?.id ?? "",
    model: opts.model,
    raw_units,
    estimated_cost,
    actual_cost: null,
    billing_currency: estimated_cost === null ? null : "USD",
    rate_version: opts.rateCard?.rate_version ?? null,
  };
}
