import {
  ModelCallError,
  ReplayExhaustedError,
  type ModelTurn,
  type PlannerModel,
  type UsageRecord,
} from "@/lib/agent/model";
import { extractUsage } from "./usage";

export interface ReplayEntry {
  response?: {
    id: string;
    model: string;
    choices: {
      message: {
        content: string | null;
        tool_calls?: { id: string; name: string; arguments: string }[];
      };
    }[];
    usage?: Record<string, number | undefined>;
  };
  error?: { status: 429 | 402 | 500 | "timeout"; retry_after_s?: number };
}

export type ReplayTranscript = { entries: ReplayEntry[] } | ReplayEntry[];

export function createReplayModel(transcript: ReplayTranscript): PlannerModel {
  const entries = Array.isArray(transcript) ? transcript : transcript.entries;
  let cursor = 0;

  return {
    async complete(req) {
      const entry =
        req?.sequence !== undefined ? entries[req.sequence] : entries[cursor++];
      if (!entry) {
        throw new ReplayExhaustedError();
      }
      if (entry.error) {
        const err = entry.error;
        if (err.status === 429) {
          throw new ModelCallError(
            "rate_limited",
            "Replayed rate limit",
            err.retry_after_s !== undefined ? err.retry_after_s * 1000 : undefined,
          );
        }
        if (err.status === 402) {
          throw new ModelCallError("quota_exceeded", "Replayed quota exceeded");
        }
        if (err.status === "timeout") {
          throw new ModelCallError("timeout", "Replayed timeout");
        }
        throw new ModelCallError("server_error", "Replayed server error");
      }
      const response = entry.response!;
      const usage: UsageRecord = extractUsage(
        {
          id: `replay-${response.id}`,
          model: `replay:${response.model}`,
          usage: response.usage,
        },
        { model: `replay:${response.model}` },
      );
      const message = response.choices[0]?.message;
      const turn: ModelTurn = {
        providerRequestId: `replay-${response.id}`,
        model: `replay:${response.model}`,
        message: {
          content: message?.content ?? null,
          tool_calls:
            message?.tool_calls && message.tool_calls.length > 0
              ? message.tool_calls
              : undefined,
        },
        usage,
      };
      return turn;
    },
  };
}

export async function loadReplayTranscript(
  name: string,
): Promise<ReplayTranscript> {
  const mod = (await import(
    `./replay-transcripts/${name}.json`
  )) as { default: ReplayTranscript };
  return mod.default;
}
