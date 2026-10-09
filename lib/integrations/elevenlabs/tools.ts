import { createHash } from "node:crypto";
import { z } from "zod";
import type { OwnerTaskKind, VoiceGrantResolution, VoiceStore } from "@/lib/db/voice-store";
import { hashVoiceToken, isVoiceToolName, VOICE_TOOLS_ALLOWED_WHILE_PAUSED, type VoiceToolName } from "./capability";
import { evaluateOffer, toInstant, type OfferTerms } from "./offer-evaluation";

export interface VoiceToolDeps {
  store: VoiceStore;
  now: () => Date;
}

export type VoiceToolResponse = {
  status: number;
  body: { ok: true; data: Record<string, unknown> } | { ok: false; code: string; message: string };
};

const decimal = z.string().trim().regex(/^\d{1,12}(\.\d{1,2})?$/, "plain decimal amount, e.g. 12.50");
const dateOrDateTime = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);
const notes = z.string().trim().max(500).optional();

// .strict(): model arguments can never carry org_id, case_id or any other scope.
const offerTermsSchema = z
  .object({
    quantity: z.number().int().min(0).max(1_000_000_000),
    currency: z.string().regex(/^[A-Z]{3}$/).optional(),
    unit_price: decimal.optional(),
    freight: decimal.optional(),
    fees: decimal.optional(),
    arrival_date: dateOrDateTime.optional(),
    quote_valid_until: dateOrDateTime.optional(),
    order_cutoff: dateOrDateTime.optional(),
    split_delivery: z.boolean().optional(),
    supplier_confirmed_readback: z.boolean().optional(),
    notes,
  })
  .strict();

export const voiceToolArgumentSchemas = {
  read_case_facts: z.object({}).strict(),
  validate_offer: offerTermsSchema,
  record_provisional_offer: offerTermsSchema,
  request_written_confirmation: z.object({ email_on_file_ok: z.boolean().optional(), notes }).strict(),
  request_human_review: z
    .object({
      reason: z.enum(["supplier_requested_human", "unclear_terms", "legal_or_contract", "safety", "case_paused", "other"]),
      notes,
    })
    .strict(),
  end_call: z
    .object({ reason: z.enum(["completed", "voicemail", "wrong_contact", "supplier_declined", "case_paused", "other"]) })
    .strict(),
} satisfies Record<VoiceToolName, z.ZodType>;

const deny = (status: number, code: string, message: string): VoiceToolResponse => ({
  status,
  body: { ok: false, code, message },
});
const ok = (data: Record<string, unknown>): VoiceToolResponse => ({ status: 200, body: { ok: true, data } });

const PROVISIONAL_MESSAGE =
  "Recorded as a provisional quote only. Tell the supplier the owner must approve and that we need written confirmation. Do not accept or commit.";

function canonicalHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function offerExcerpt(terms: OfferTerms, unit: string): string {
  const parts = [`${terms.quantity} ${unit}`];
  if (terms.unit_price) parts.push(`unit price ${terms.unit_price} ${terms.currency ?? "?"}`);
  if (terms.freight) parts.push(`freight ${terms.freight}`);
  if (terms.fees) parts.push(`fees ${terms.fees}`);
  if (terms.arrival_date) parts.push(`arrival by ${terms.arrival_date}`);
  if (terms.quote_valid_until) parts.push(`valid until ${terms.quote_valid_until}`);
  if (terms.order_cutoff) parts.push(`order by ${terms.order_cutoff}`);
  if (terms.split_delivery !== undefined) parts.push(terms.split_delivery ? "split delivery possible" : "no split delivery");
  return `Verbal supplier offer (unverified): ${parts.join(", ")}.`;
}

const OWNER_TASK_FOR: Record<string, { kind: OwnerTaskKind; reason: string } | null> = {
  within: null,
  above: { kind: "above_ceiling", reason: "Offer exceeds the negotiation ceiling; owner review required." },
  not_configured: { kind: "ceiling_not_configured", reason: "No negotiation ceiling configured; owner review required." },
  unknown_cost: { kind: "human_review", reason: "Offer cost could not be computed from the stated terms." },
};

async function execute(
  tool: VoiceToolName,
  args: Record<string, unknown>,
  grant: VoiceGrantResolution,
  deps: VoiceToolDeps,
): Promise<VoiceToolResponse> {
  const at = deps.now();
  const scope = { orgId: grant.org_id, caseId: grant.case_id, actionId: grant.action_id };
  const log = (resultCode: string, payload: Record<string, unknown>) =>
    deps.store.recordToolEvent({ ...scope, tool, resultCode, payload, at });

  switch (tool) {
    case "read_case_facts": {
      const facts = await deps.store.caseFacts(grant.org_id, grant.case_id, grant.contact_id);
      if (!facts) return deny(404, "facts_unavailable", "Order facts are unavailable; request human review.");
      await log("ok", {});
      return ok({
        company_name: facts.org_name,
        supplier_name: facts.supplier_name,
        contact_name: facts.contact_name,
        item_sku: facts.item_sku,
        item_description: facts.item_description,
        unit: facts.unit,
        destination: facts.destination,
        quantity_needed: facts.bridge_qty,
        needed_by: facts.first_shortage_at,
        orders: facts.order_lines,
      });
    }
    case "validate_offer":
    case "record_provisional_offer": {
      const terms = args as unknown as OfferTerms & { supplier_confirmed_readback?: boolean; notes?: string };
      const context = await deps.store.offerContext(grant.org_id, grant.case_id, grant.contact_id);
      if (!context) return deny(404, "facts_unavailable", "Order facts are unavailable; request human review.");
      const evaluation = evaluateOffer(terms, context);
      if (tool === "validate_offer") {
        await log("ok", { missing_fields: evaluation.missing_fields });
        return ok({
          missing_fields: evaluation.missing_fields,
          meets_quantity: evaluation.meets_quantity,
          meets_deadline: evaluation.meets_deadline,
          next_step:
            evaluation.missing_fields.length > 0
              ? "Ask the supplier for the missing fields, then repeat all terms back."
              : "Repeat all terms back for confirmation, then record the provisional offer.",
        });
      }
      if (terms.quantity <= 0) return deny(422, "invalid_arguments", "Quantity must be positive to record an offer.");
      const ownerTask = OWNER_TASK_FOR[evaluation.ceiling_status];
      const result = await deps.store.recordProvisionalOffer({
        org_id: grant.org_id,
        case_id: grant.case_id,
        action_id: grant.action_id,
        contact_id: grant.contact_id,
        conversation_id: grant.conversation_id,
        recorded_at: at.toISOString(),
        content_hash: canonicalHash(terms),
        excerpt: offerExcerpt(terms, context.unit),
        quantity: terms.quantity,
        unit: context.unit,
        unit_price_minor: evaluation.unit_price_minor?.toString() ?? null,
        currency: terms.currency ?? context.org_currency,
        freight_minor: evaluation.freight_minor?.toString() ?? null,
        fees_minor: evaluation.fees_minor?.toString() ?? null,
        arrival_by: toInstant(terms.arrival_date, context.timezone)?.toISOString() ?? null,
        valid_until: toInstant(terms.quote_valid_until, context.timezone)?.toISOString() ?? null,
        order_cutoff: toInstant(terms.order_cutoff, context.timezone, "start")?.toISOString() ?? null,
        added_cost_minor: evaluation.added_cost_minor?.toString() ?? null,
        owner_task_kind: ownerTask?.kind ?? null,
        owner_task_reason: ownerTask?.reason ?? null,
      });
      // Same response regardless of ceiling result, so the agent cannot learn or leak the ceiling.
      return ok({
        status: "provisional",
        quote_id: result.quote_id,
        missing_fields: evaluation.missing_fields,
        message: PROVISIONAL_MESSAGE,
      });
    }
    case "request_written_confirmation": {
      const taskId = await deps.store.createOwnerTask({
        ...scope,
        kind: "written_confirmation",
        reason: "Supplier asked to confirm call terms in writing.",
        detail: { email_on_file_ok: (args.email_on_file_ok as boolean | undefined) ?? null },
        at,
      });
      await log("ok", { owner_task_id: taskId });
      return ok({ status: "requested", message: "Tell the supplier we will email them to confirm the terms in writing." });
    }
    case "request_human_review": {
      const taskId = await deps.store.createOwnerTask({
        ...scope,
        kind: "human_review",
        reason: `Voice agent requested human review: ${String(args.reason)}.`,
        detail: { reason: args.reason, supplier_notes_untrusted: args.notes ?? null },
        at,
      });
      await log("ok", { owner_task_id: taskId, reason: args.reason });
      return ok({
        status: "requested",
        message: "Tell the supplier the owner will follow up, thank them, and end the call.",
      });
    }
    case "end_call": {
      await log("ok", { reason: args.reason });
      return ok({ status: "ending", message: "Thank the supplier and hang up now." });
    }
  }
}

/**
 * Authenticates a voice tool call. Scope (org/case/contact/action) comes only from the hashed grant;
 * the grant, its expiry, the tool allowlist and the case's current run_control are checked on every call.
 */
export async function handleVoiceToolRequest(
  toolName: string,
  token: string | null,
  body: unknown,
  deps: VoiceToolDeps,
): Promise<VoiceToolResponse> {
  if (!isVoiceToolName(toolName)) return deny(404, "unknown_tool", "Unknown tool.");
  if (!token) return deny(401, "unauthorized", "Missing call credential.");
  const grant = await deps.store.resolveGrant(hashVoiceToken(token));
  if (!grant) return deny(401, "unauthorized", "Invalid call credential.");
  if (grant.revoked_at) return deny(401, "grant_revoked", "This call's access has ended.");
  if (deps.now().getTime() >= new Date(grant.expires_at).getTime()) {
    return deny(401, "grant_expired", "This call's access has expired. Request human review and end the call.");
  }
  if (!grant.allowed_tools.includes(toolName)) return deny(403, "tool_not_allowed", "Tool not allowed on this call.");

  const halted = grant.run_control !== "active" || grant.case_phase === "closed";
  if (halted && !VOICE_TOOLS_ALLOWED_WHILE_PAUSED.has(toolName)) {
    await deps.store.recordToolEvent({
      orgId: grant.org_id,
      caseId: grant.case_id,
      actionId: grant.action_id,
      tool: toolName,
      resultCode: "denied_case_paused",
      payload: { run_control: grant.run_control },
      at: deps.now(),
    });
    return deny(
      409,
      "case_paused",
      "The owner has paused this case. Do not record or negotiate anything further; thank the supplier and end the call.",
    );
  }

  const parsed = voiceToolArgumentSchemas[toolName].safeParse(body ?? {});
  if (!parsed.success) {
    return deny(422, "invalid_arguments", "Arguments rejected. Only the documented fields are accepted.");
  }
  return execute(toolName, parsed.data as Record<string, unknown>, grant, deps);
}
