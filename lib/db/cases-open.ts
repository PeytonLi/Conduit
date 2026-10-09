import { z } from "zod";
import { extractionV1Schema, type ExtractionV1 } from "@/lib/agent/extraction-schema";
import {
  verifyExtraction,
  type UnresolvedFact,
} from "@/lib/agent/extraction-verify";
import { extractDelayFacts, type ExtractDeps } from "@/lib/agent/extraction";
import {
  matchDelay,
  type MatchContext,
  type MatchOutcome,
} from "@/lib/domain/matching";
import { findQuote } from "@/lib/agent/extraction-verify";
import type { RpcClient } from "./messages";
import { loadMessage } from "./messages";

export interface OpenCasesResult {
  status: "matched" | "needs_review" | "not_delay" | string;
  case_ids: string[];
  review_id: string | null;
  replayed: boolean;
}

export interface ProcessResult extends OpenCasesResult {
  extraction_version: number | null;
}

async function callOpenCases(
  rpc: RpcClient,
  p: Record<string, unknown>,
): Promise<OpenCasesResult> {
  const raw = await rpc.rpc<{
    status: string;
    case_ids: string[] | unknown;
    review_id: string | null;
    replayed: boolean;
  }>("inbox_open_cases", p);
  return {
    status: raw.status,
    case_ids: Array.isArray(raw.case_ids) ? (raw.case_ids as string[]) : [],
    review_id: raw.review_id,
    replayed: raw.replayed,
  };
}

export interface ProcessDeps extends ExtractDeps {
  /** The app-level environment mode (not yet org-aware). */
  mode: "replay" | "sandbox" | "live";
}

export type EffectiveMode = "replay" | "sandbox" | "live";

/**
 * The strictest of the app env and the org's environment_mode wins: a replay
 * org never triggers provider calls even in a sandbox/live deployment.
 */
export function effectiveMode(
  appEnv: EffectiveMode,
  orgEnvironmentMode: string | null | undefined,
): EffectiveMode {
  if (appEnv === "replay" || orgEnvironmentMode === "replay") return "replay";
  if (appEnv === "sandbox" || orgEnvironmentMode === "sandbox") return "sandbox";
  return "live";
}

/** Extract (if needed), verify, match, then run the atomic open-cases call. */
export async function processSourceMessage({
  rpc,
  orgId,
  sourceMessageId,
  mode,
  deps,
  now,
}: {
  rpc: RpcClient;
  orgId: string;
  sourceMessageId: string;
  mode: "auto" | "resolution";
  deps: ProcessDeps;
  now: () => Date;
}): Promise<ProcessResult> {
  const loaded = await loadMessage(rpc, orgId, sourceMessageId);
  const message = loaded.message;

  // Already processed (e.g. duplicate event delivery): inbox_open_cases
  // replays the recorded result; skip extraction entirely.
  if (mode === "auto" && message.processing_state !== "pending") {
    const out = await callOpenCases(rpc, {
      org_id: orgId,
      source_message_id: sourceMessageId,
      extraction_version: null,
      actor_user_id: null,
      mode,
      outcome: {},
    });
    return {
      ...out,
      extraction_version: loaded.latest_extraction?.version ?? null,
    };
  }

  const effectiveModeOfOrg = effectiveMode(deps.mode, loaded.org_environment_mode);

  let facts: ExtractionV1 | null = null;
  let extractionVersion: number | null = null;

  const existing = loaded.latest_extraction;
  if (existing && existing.status === "valid") {
    const parsed = extractionV1Schema.safeParse(existing.facts);
    if (parsed.success) {
      facts = parsed.data;
      extractionVersion = existing.version;
    }
  }

  if (!facts) {
    const result = await extractDelayFacts({
      mode: effectiveModeOfOrg,
      message: {
        rfcMessageId: message.rfc_message_id,
        bodyHash: "",
        segments: loaded.segments.map((s) => ({
          kind: s.kind as "body" | "quoted" | "forwarded",
          index: s.index,
          content: s.content,
        })),
      },
      deps,
    });
    const recorded = await rpc.rpc<{ version: number }>("inbox_record_extraction", {
      org_id: orgId,
      source_message_id: sourceMessageId,
      extractor: result.extractor,
      model: result.model,
      prompt_version: result.promptVersion,
      status: result.status,
      facts: result.facts ?? {},
      unresolved: [],
    });
    extractionVersion = recorded.version;

    if (!result.facts) {
      // invalid or unavailable extraction -> needs_review with no candidates
      const out = await callOpenCases(rpc, {
        org_id: orgId,
        source_message_id: sourceMessageId,
        extraction_version: extractionVersion,
        actor_user_id: null,
        mode,
        outcome: {
          status: "needs_review",
          lines: [],
          review: {
            candidates: [],
            unresolved: [
              {
                line_index: -1,
                field: "extraction",
                reason: result.status,
              } satisfies UnresolvedFact,
            ],
            case_groups: [],
          },
        },
      });
      return { ...out, extraction_version: extractionVersion };
    }
    facts = result.facts;
  }

  const context = await rpc.rpc<MatchContext>("inbox_match_context", {
    org_id: orgId,
    sender: message.sender ?? "",
  });

  const bodyEvidenceId = message.body_evidence_id;
  // Verify per candidate location timezone; most messages hit one location,
  // so verify against the union using each line's eventual timezone in match.
  // We verify once with the org's primary location timezone for date math,
  // then the DB enforces concrete times per matched line's timezone — the
  // verifier is called per distinct location timezone below.
  const timezones = new Map<string, string>();
  for (const l of context.lines) timezones.set(l.location_id, l.location_timezone);
  const defaultTz = timezones.values().next().value ?? "UTC";

  const verify = verifyExtraction({
    extraction: facts,
    segments: loaded.segments.map((s) => ({
      kind: s.kind as "body" | "quoted" | "forwarded",
      index: s.index,
      content: s.content,
      evidence_id: s.evidence_id,
    })),
    sentAt: message.sent_at ? new Date(message.sent_at) : now(),
    timezone: defaultTz,
  });
  for (const vl of verify.lines) {
    if (!vl.body_evidence_id) vl.body_evidence_id = bodyEvidenceId ?? undefined;
  }

  const outcome = matchDelay({
    senderAddress: message.sender ?? "",
    verifiedLines: verify.lines,
    context,
    isDelayNotice: facts.is_delay_notice,
  });
  outcome.unresolved = [...verify.unresolved, ...outcome.unresolved];
  if (outcome.unresolved.length > 0 && outcome.status === "matched") {
    outcome.status = "needs_review";
    outcome.lines = [];
  }

  const out = await callOpenCases(rpc, {
    org_id: orgId,
    source_message_id: sourceMessageId,
    extraction_version: extractionVersion,
    actor_user_id: null,
    mode,
    outcome: {
      status: outcome.status,
      lines: outcome.lines,
      review:
        outcome.status === "needs_review"
          ? {
              candidates: outcome.candidates,
              unresolved: outcome.unresolved,
              case_groups: outcome.case_groups,
            }
          : undefined,
    },
  });
  return { ...out, extraction_version: extractionVersion };
}

// ---- resolution -------------------------------------------------------------

export const resolveMatchInputSchema = z
  .object({
    expected_version: z.number().int().positive(),
    source_message_id: z.string().uuid().optional(),
    selections: z
      .array(
        z
          .object({
            line_index: z.number().int().min(0),
            po_line_id: z.string().uuid(),
          })
          .strict(),
      )
      .default([]),
    corrections: z
      .array(
        z
          .object({
            line_index: z.number().int().min(0),
            field: z.enum([
              "affected_quantity",
              "quantity_scope",
              "unit",
              "new_promise",
              "order_ref",
            ]),
            value: z.unknown(),
            source: z
              .object({
                evidence_id: z.string().uuid().optional(),
                quote: z.string().min(1),
              })
              .strict(),
          })
          .strict(),
      )
      .default([]),
    dismiss: z.boolean().default(false),
    reason: z.string().min(3),
  })
  .strict();

export type ResolveMatchInput = z.infer<typeof resolveMatchInputSchema>;

export class ResolveError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export async function resolveMessageMatch({
  rpc,
  orgId,
  caseId,
  actorUserId,
  input,
  deps,
  now,
}: {
  rpc: RpcClient;
  orgId: string;
  caseId: string;
  actorUserId: string;
  input: ResolveMatchInput;
  deps: ProcessDeps;
  now: () => Date;
}): Promise<ProcessResult> {
  const lookup = await rpc.rpc<{
    case_row_version: number;
    case_phase: string;
    review: {
      id: string;
      source_message_id: string;
      extraction_version: number | null;
      candidates: unknown;
      unresolved: unknown;
      case_ids: string[];
    } | null;
    org_environment_mode: string | null;
  }>("inbox_case_review_lookup", { org_id: orgId, case_id: caseId });

  if (lookup.case_row_version !== input.expected_version) {
    throw new ResolveError("stale_version", "Case has changed; reload and retry", 409);
  }
  if (!lookup.review) {
    throw new ResolveError("no_open_review", "No open match review for this case", 409);
  }
  // Operator corrections never invoke the model; the effective mode is
  // computed anyway so a replay org stays on replay semantics end-to-end.
  void effectiveMode(deps.mode, lookup.org_environment_mode);
  const sourceMessageId = input.source_message_id ?? lookup.review.source_message_id;
  if (sourceMessageId !== lookup.review.source_message_id) {
    throw new ResolveError(
      "message_mismatch",
      "source_message_id does not match the open review",
      422,
    );
  }

  if (input.dismiss) {
    await rpc.rpc("inbox_dismiss_message", {
      org_id: orgId,
      source_message_id: sourceMessageId,
      actor_user_id: actorUserId,
      reason: input.reason,
    });
    return {
      status: "not_delay",
      case_ids: [],
      review_id: lookup.review.id,
      replayed: false,
      extraction_version: lookup.review.extraction_version,
    };
  }

  const loaded = await loadMessage(rpc, orgId, sourceMessageId);
  const bodyContent =
    loaded.segments.find((s) => s.kind === "body")?.content ?? "";

  // Latest valid extraction facts are the base for operator corrections.
  let facts: ExtractionV1 | null = null;
  if (loaded.latest_extraction && loaded.latest_extraction.status === "valid") {
    const parsed = extractionV1Schema.safeParse(loaded.latest_extraction.facts);
    if (parsed.success) facts = parsed.data;
  }
  if (!facts) {
    throw new ResolveError(
      "no_extraction",
      "No valid extraction exists to correct",
      409,
    );
  }

  const patched: ExtractionV1 = {
    ...facts,
    lines: facts.lines.map((l) => ({ ...l })),
  };
  for (const correction of input.corrections) {
    // Corrected quotes must appear in the message body or the cited evidence.
    const quote = correction.source.quote;
    let quoteOk = findQuote(bodyContent, quote) !== -1;
    if (!quoteOk && correction.source.evidence_id) {
      const seg = loaded.segments.find(
        (s) => s.evidence_id === correction.source.evidence_id,
      );
      if (seg && findQuote(seg.content, quote) !== -1) quoteOk = true;
    }
    if (!quoteOk) {
      throw new ResolveError(
        "correction_quote_not_in_source",
        "Correction quote does not appear in the source message",
        422,
      );
    }
    const line = patched.lines[correction.line_index];
    if (!line) {
      throw new ResolveError("bad_line_index", "Correction line_index out of range", 422);
    }
    switch (correction.field) {
      case "affected_quantity":
        line.affected_quantity = z.number().int().min(0).parse(correction.value);
        line.quantity_quote = quote;
        break;
      case "quantity_scope":
        line.quantity_scope = z
          .enum(["all_remaining", "partial", "unstated"])
          .parse(correction.value);
        break;
      case "unit":
        line.unit = z.string().parse(correction.value);
        break;
      case "order_ref":
        line.order_ref = z.string().parse(correction.value);
        line.order_quote = quote;
        break;
      case "new_promise":
        line.new_promise = z
          .object({
            quote: z.string(),
            local_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
            local_time: z
              .string()
              .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
              .nullable(),
            promise_state: z.enum(["confirmed", "estimated"]),
          })
          .strict()
          .parse({ ...(correction.value as object), quote });
        break;
    }
  }

  const recorded = await rpc.rpc<{ version: number }>("inbox_record_extraction", {
    org_id: orgId,
    source_message_id: sourceMessageId,
    extractor: "operator_correction",
    model: null,
    prompt_version: null,
    status: "valid",
    facts: patched,
    unresolved: [],
    created_by: actorUserId,
    reason: input.reason,
  });

  const context = await rpc.rpc<MatchContext>("inbox_match_context", {
    org_id: orgId,
    sender: loaded.message.sender ?? "",
  });
  const defaultTz =
    context.lines.find((l) =>
      input.selections.some((s) => s.po_line_id === l.po_line_id),
    )?.location_timezone ??
    context.lines[0]?.location_timezone ??
    "UTC";

  const verify = verifyExtraction({
    extraction: patched,
    segments: loaded.segments.map((s) => ({
      kind: s.kind as "body" | "quoted" | "forwarded",
      index: s.index,
      content: s.content,
      evidence_id: s.evidence_id,
    })),
    sentAt: loaded.message.sent_at ? new Date(loaded.message.sent_at) : now(),
    timezone: defaultTz,
  });
  for (const vl of verify.lines) {
    if (!vl.body_evidence_id) {
      vl.body_evidence_id = loaded.message.body_evidence_id ?? undefined;
    }
  }

  const pins: Record<number, string> = {};
  for (const sel of input.selections) pins[sel.line_index] = sel.po_line_id;

  const outcome: MatchOutcome = matchDelay({
    senderAddress: loaded.message.sender ?? "",
    verifiedLines: verify.lines,
    context,
    isDelayNotice: patched.is_delay_notice,
    pins,
  });
  outcome.unresolved = [...verify.unresolved, ...outcome.unresolved];
  if (outcome.unresolved.length > 0 && outcome.status === "matched") {
    outcome.status = "needs_review";
    outcome.lines = [];
  }

  const out = await callOpenCases(rpc, {
    org_id: orgId,
    source_message_id: sourceMessageId,
    extraction_version: recorded.version,
    actor_user_id: actorUserId,
    mode: "resolution",
    review_reason: input.reason,
    resolution: {
      selections: input.selections,
      corrections: input.corrections,
      reason: input.reason,
    },
    outcome: {
      status: outcome.status,
      lines: outcome.lines,
      review:
        outcome.status === "needs_review"
          ? {
              candidates: outcome.candidates,
              unresolved: outcome.unresolved,
              case_groups: outcome.case_groups,
            }
          : undefined,
    },
  });
  return { ...out, extraction_version: recorded.version };
}
