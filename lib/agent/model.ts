export interface UsageRecord {
  provider: string;
  request_id: string;
  model: string;
  raw_units: Record<string, number>;
  /** Decimal string (12 fractional digits) or null when unknown. Never "0" for unknown. */
  estimated_cost: string | null;
  actual_cost: string | null;
  billing_currency: "USD" | null;
  rate_version: string | null;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelToolCall {
  id: string;
  name: string;
  /** Raw JSON string of arguments. */
  arguments: string;
}

export interface ModelTurn {
  providerRequestId: string;
  model: string;
  message: {
    content: string | null;
    tool_calls?: ModelToolCall[];
  };
  usage: UsageRecord;
}

export interface PlannerModel {
  complete(req: {
    messages: ChatMessage[];
    tools: ToolDef[];
    /** Persisted episode request count — lets replay models index transcripts deterministically. */
    sequence?: number;
  }): Promise<ModelTurn>;
}

export type ModelErrorKind =
  | "rate_limited"
  | "quota_exceeded"
  | "timeout"
  | "server_error"
  | "bad_request";

export class ModelCallError extends Error {
  readonly kind: ModelErrorKind;
  readonly retryAfterMs?: number;

  constructor(kind: ModelErrorKind, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "ModelCallError";
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

export class ModelUnavailableError extends Error {
  readonly code = "provider_unavailable";

  constructor(message: string) {
    super(message);
    this.name = "ModelUnavailableError";
  }
}

export class ReplayExhaustedError extends Error {
  constructor(message = "Replay transcript exhausted") {
    super(message);
    this.name = "ReplayExhaustedError";
  }
}
