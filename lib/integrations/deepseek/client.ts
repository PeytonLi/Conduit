import OpenAI, {
  APIConnectionTimeoutError,
  APIError,
} from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions/completions";
import {
  ModelCallError,
  ModelUnavailableError,
  type ModelTurn,
  type PlannerModel,
} from "@/lib/agent/model";
import { isTelemetryEnabled, getNeatlogs } from "@/lib/telemetry";
import { extractUsage, type DeepSeekRateCard } from "./usage";

export interface DeepSeekEnv {
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_BASE_URL?: string;
  DEEPSEEK_MODEL?: string;
  NEATLOGS_API_KEY?: string;
}

export interface DeepSeekDeps {
  openaiClient?: OpenAI;
  rateCard?: DeepSeekRateCard;
}

function headersGet(headers: unknown, name: string): string | null {
  if (!headers) return null;
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name);
  }
  const record = headers as Record<string, string>;
  return record[name] ?? record[name.toLowerCase()] ?? null;
}

export function toModelCallError(error: unknown): ModelCallError {
  const status = error instanceof APIError ? error.status : undefined;
  const headers = error instanceof APIError ? error.headers : undefined;
  const retryAfterHeader = headersGet(headers, "retry-after");
  const retryAfterMs =
    retryAfterHeader !== null && !Number.isNaN(Number(retryAfterHeader))
      ? Number(retryAfterHeader) * 1000
      : undefined;

  if (status === 429) {
    return new ModelCallError("rate_limited", "Provider rate limited", retryAfterMs);
  }
  if (status === 402) {
    return new ModelCallError("quota_exceeded", "Provider quota exceeded");
  }
  if (status === 408 || error instanceof APIConnectionTimeoutError) {
    return new ModelCallError("timeout", "Provider request timed out");
  }
  if (status !== undefined && status >= 500) {
    return new ModelCallError("server_error", "Provider server error", retryAfterMs);
  }
  return new ModelCallError("bad_request", "Provider rejected the request");
}

export function createDeepSeekModel(
  env: DeepSeekEnv,
  deps: DeepSeekDeps = {},
): PlannerModel {
  const apiKey = env.DEEPSEEK_API_KEY;
  const model = env.DEEPSEEK_MODEL;
  if (!apiKey || !model) {
    throw new ModelUnavailableError(
      "DeepSeek capability unavailable: DEEPSEEK_API_KEY and DEEPSEEK_MODEL are required",
    );
  }

  let client =
    deps.openaiClient ??
    new OpenAI({
      apiKey,
      baseURL: env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
      timeout: 60_000,
      maxRetries: 0,
    });

  if (env.NEATLOGS_API_KEY && isTelemetryEnabled()) {
    const neatlogs = getNeatlogs() as { wrapOpenAI?: <T>(client: T) => T } | null;
    if (neatlogs?.wrapOpenAI) {
      client = neatlogs.wrapOpenAI(client) as OpenAI;
    }
  }

  return {
    async complete(req) {
      const tools = req.tools.map((tool) => ({
        type: "function" as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
      const params = {
        model,
        messages: req.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        tools: tools.length > 0 ? tools : undefined,
        tool_choice: "auto" as const,
        // DeepSeek thinking toggle — extra top-level body field.
        thinking: { type: "disabled" },
      } as unknown as ChatCompletionCreateParamsNonStreaming;

      let response;
      try {
        response = await client.chat.completions.create(params);
      } catch (error) {
        throw toModelCallError(error);
      }

      const choice = response.choices?.[0];
      const toolCalls = choice?.message?.tool_calls
        ?.filter(
          (call): call is Extract<typeof call, { type: "function" }> =>
            call.type === "function",
        )
        .map((call) => ({
          id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        }));

      const turn: ModelTurn = {
        providerRequestId: response.id ?? "",
        model: response.model ?? model,
        message: {
          content: choice?.message?.content ?? null,
          tool_calls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
        },
        usage: extractUsage(response, { model, rateCard: deps.rateCard }),
      };
      return turn;
    },
  };
}

export { toolInputToJsonSchema } from "@/lib/agent/tool-schema";
