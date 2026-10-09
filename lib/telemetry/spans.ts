import { getNeatlogs, isTelemetryEnabled } from "./index";
import { maskTelemetry } from "./mask";

export type BusinessSpanName =
  | "matching"
  | "inventory_calc"
  | "source_retrieval"
  | "quote_validation"
  | "action_prep"
  | "call_request"
  | "call_result"
  | "approval_check"
  | "execution"
  | "reconciliation"
  | "planner_inference";

export interface CorrelationAttrs {
  org_pseudonym?: string;
  case_id?: string;
  episode?: number;
  assessment_version?: number;
  plan_version?: number;
  action_id?: string;
  model?: string;
  prompt_version?: string;
  provider_request_id?: string;
  conversation_id?: string;
}

const KINDS: Record<BusinessSpanName, string> = {
  planner_inference: "AGENT",
  approval_check: "GUARDRAIL",
  matching: "TOOL",
  inventory_calc: "TOOL",
  source_retrieval: "TOOL",
  quote_validation: "TOOL",
  action_prep: "TOOL",
  call_request: "TOOL",
  call_result: "CHAIN",
  execution: "CHAIN",
  reconciliation: "CHAIN",
};

export async function withBusinessSpan<T>(
  name: BusinessSpanName,
  attrs: CorrelationAttrs,
  fn: () => Promise<T> | T,
  options?: { safeInput?: unknown },
): Promise<T> {
  const neatlogs = getNeatlogs();
  if (!isTelemetryEnabled() || !neatlogs) {
    return fn();
  }
  let input: unknown;
  try {
    input = options?.safeInput === undefined ? undefined : maskTelemetry(options.safeInput);
  } catch {
    input = undefined;
  }
  let fnRan = false;
  try {
    return await neatlogs.trace(
      { name: `conduit.${name}`, kind: KINDS[name], input },
      (span) => {
        for (const [key, value] of Object.entries(attrs)) {
          if (value !== undefined) {
            span.setAttribute(`conduit.${key}`, value);
          }
        }
        fnRan = true;
        return fn();
      },
    );
  } catch (error) {
    // Business errors propagate unchanged; a telemetry failure before fn ran
    // must not alter the result — run fn once directly.
    if (fnRan) throw error;
    return fn();
  }
}
