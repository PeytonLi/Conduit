export const CALL_OUTCOMES = [
  "answered_with_offer",
  "answered_no_solution",
  "needs_human",
  "voicemail",
  "no_answer",
  "busy",
  "initiation_failed",
  "interrupted",
] as const;

export type CallOutcome = (typeof CALL_OUTCOMES)[number];
export type ProcurementResult = "provisional_offer" | "no_offer" | "not_reached";

export interface NormalizedCallOutcome {
  outcome: CallOutcome;
  /** Provider status preserved verbatim (conversation status or initiation failure reason). */
  provider_status: string | null;
  /** Did the telephony leg complete normally? Independent of whether anything useful was agreed. */
  transport_completed: boolean;
  /** Procurement result; an offer is always provisional until verified and approved by the owner. */
  procurement_result: ProcurementResult;
  detail: {
    termination_reason: string | null;
    failure_reason: string | null;
    sip_status_code: number | null;
    duration_seconds: number | null;
    supplier_turns: number;
  };
}

/** Facts recorded by our own tool endpoints during the call (trusted, unlike the transcript). */
export interface CallToolSummary {
  offer_recorded: boolean;
  human_review_requested: boolean;
  end_call_logged: boolean;
}

export interface InitiationFailureInput {
  failure_reason: string | null;
  sip_status_code: number | null;
}

export function normalizeInitiationFailure(input: InitiationFailureInput): NormalizedCallOutcome {
  const reason = input.failure_reason?.toLowerCase() ?? null;
  const outcome: CallOutcome =
    reason === "busy" || input.sip_status_code === 486 || input.sip_status_code === 600
      ? "busy"
      : reason === "no-answer" || reason === "no_answer" || input.sip_status_code === 480 || input.sip_status_code === 408
        ? "no_answer"
        : "initiation_failed";
  return {
    outcome,
    provider_status: input.failure_reason,
    transport_completed: false,
    procurement_result: "not_reached",
    detail: {
      termination_reason: null,
      failure_reason: input.failure_reason,
      sip_status_code: input.sip_status_code,
      duration_seconds: null,
      supplier_turns: 0,
    },
  };
}

export interface TranscriptionInput {
  status: string | null;
  termination_reason: string | null;
  error_present: boolean;
  duration_seconds: number | null;
  supplier_turns: number;
  voicemail_detected: boolean;
}

export function normalizeTranscription(input: TranscriptionInput, tools: CallToolSummary): NormalizedCallOutcome {
  const transportCompleted = input.status === "done" && !input.error_present;
  const voicemail = input.voicemail_detected || /voicemail|answering machine/i.test(input.termination_reason ?? "");

  let outcome: CallOutcome;
  if (voicemail) outcome = "voicemail";
  else if (tools.offer_recorded) outcome = "answered_with_offer";
  else if (input.supplier_turns === 0) outcome = transportCompleted ? "no_answer" : "interrupted";
  else if (tools.human_review_requested) outcome = "needs_human";
  else if (!transportCompleted) outcome = "interrupted";
  else outcome = "answered_no_solution";

  return {
    outcome,
    provider_status: input.status,
    transport_completed: transportCompleted,
    procurement_result:
      outcome === "answered_with_offer"
        ? "provisional_offer"
        : outcome === "voicemail" || outcome === "no_answer"
          ? "not_reached"
          : "no_offer",
    detail: {
      termination_reason: input.termination_reason,
      failure_reason: null,
      sip_status_code: null,
      duration_seconds: input.duration_seconds,
      supplier_turns: input.supplier_turns,
    },
  };
}
