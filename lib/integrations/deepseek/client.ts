import OpenAI, {
  APIConnectionTimeoutError,
  APIError,
} from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions/completions";
import {
  ModelCallError,
  ModelUnavailableError,
  type ChatMessage,
  type ModelTurn,
  type PlannerModel,
} from "@/lib/agent/model";
import { extractUsage, type DeepSeekRateCard } from "./usage";
import {
  isThinkingEnabled,
  sharedReasoningVault,
  stripInlineReasoning,
  thinkingParam,
  type ReasoningVault,
} from "./thinking";

export interface DeepSeekEnv {
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_BASE_URL?: string;
  DEEPSEEK_MODEL?: string;
  /** Thinking mode is on only when exactly "true". Default off. */
  DEEPSEEK_THINKING_ENABLED?: string;
}

export interface DeepSeekDeps {
  openaiClient?: OpenAI;
  rateCard?: DeepSeekRateCard;
  /** Private server-only reasoning state; defaults to the process-wide vault. */
  vault?: ReasoningVault;
}

/**
 * Builds the provider message list. With thinking on, a tool-result summary
 * that names a vault entry expands to the assistant tool-call turn (with its
 * private reasoning_content, which DeepSeek requires on tools requests) plus
 * the matching tool message. Anything else — including a vault miss — is sent
 * as the plain text message, which never needs reasoning_content.
 */
function toProviderMessages(
  messages: ChatMessage[],
  vault: ReasoningVault | null,
): { wire: Record<string, unknown>[]; replayed: number } {
  const wire: Record<string, unknown>[] = [];
  let replayed = 0;
  for (const message of messages) {
    const turn =
      vault && message.continuationRef ? vault.get(message.continuationRef) : undefined;
    if (!turn) {
      wire.push({ role: message.role, content: message.content });
      continue;
    }
    wire.push({
      role: "assistant",
      content: turn.content,
      reasoning_content: turn.reasoningContent,
      tool_calls: [
        {
          id: turn.toolCall.id,
          type: "function",
          function: { name: turn.toolCall.name, arguments: turn.toolCall.arguments },
        },
      ],
    });
    wire.push({ role: "tool", tool_call_id: turn.toolCall.id, content: message.content });
    replayed += 1;
  }
  return { wire, replayed };
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

  const client =
    deps.openaiClient ??
    new OpenAI({
      apiKey,
      baseURL: env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
      timeout: 60_000,
      maxRetries: 0,
    });
  const thinkingOn = isThinkingEnabled(env);
  const vault = deps.vault ?? sharedReasoningVault;

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
      const buildParams = (messages: Record<string, unknown>[]) =>
        ({
          model,
          messages,
          tools: tools.length > 0 ? tools : undefined,
          tool_choice: "auto" as const,
          // DeepSeek thinking toggle — extra top-level body field.
          thinking: thinkingParam(thinkingOn),
        }) as unknown as ChatCompletionCreateParamsNonStreaming;

      const primary = toProviderMessages(req.messages, thinkingOn ? vault : null);
      let response;
      try {
        response = await client.chat.completions.create(buildParams(primary.wire));
      } catch (error) {
        const failure = toModelCallError(error);
        if (primary.replayed === 0 || failure.kind !== "bad_request") throw failure;
        // The provider rejected the replayed reasoning turns: retry once with
        // plain-text summaries only (no assistant turns, so no reasoning needed).
        try {
          response = await client.chat.completions.create(
            buildParams(toProviderMessages(req.messages, null).wire),
          );
        } catch (retryError) {
          throw toModelCallError(retryError);
        }
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

      const rawContent = choice?.message?.content ?? null;
      const content =
        thinkingOn && rawContent !== null ? stripInlineReasoning(rawContent) : rawContent;

      const turn: ModelTurn = {
        providerRequestId: response.id ?? "",
        model: response.model ?? model,
        message: {
          content,
          tool_calls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
        },
        usage: extractUsage(response, { model, rateCard: deps.rateCard }),
      };

      // reasoning_content never leaves this function except into the private
      // vault; the turn only carries an opaque handle.
      if (thinkingOn && toolCalls && toolCalls.length > 0) {
        const reasoning = (choice?.message as { reasoning_content?: unknown } | undefined)
          ?.reasoning_content;
        if (typeof reasoning === "string" && reasoning.length > 0) {
          turn.continuationRef = vault.put({
            content,
            toolCall: toolCalls[0],
            reasoningContent: reasoning,
          });
        }
      }
      return turn;
    },
  };
}

export { toolInputToJsonSchema } from "@/lib/agent/tool-schema";
