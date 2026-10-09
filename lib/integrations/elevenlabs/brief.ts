import type { VoiceCallContext } from "@/lib/db/voice-store";
import type { SupplierCallPayload } from "./payload";

export const AI_DISCLOSURE_TEMPLATE = (company: string) =>
  `Hello, this is an automated AI assistant calling on behalf of ${company}. This call is about an existing order.`;

export const OWNER_APPROVAL_STATEMENT =
  "I can't accept or commit to anything on this call; the business owner has to approve any change, and we'll ask you to confirm in writing.";

/** Required supplier questions (PRD ch.05 §5). */
export const CALL_QUESTIONS = [
  "How many units can you supply toward this need, and are they the exact same item?",
  "When can they arrive at our destination? Please give a specific date.",
  "What is the unit price and currency, and are there freight or other fees?",
  "Can you split the delivery if the full quantity is not available at once?",
  "How long is this quote valid, and what is the latest time we must order to get that arrival date?",
  "Can you confirm these terms in writing by email?",
] as const;

export type CallBriefVariables = Record<string, string | number | boolean>;

export type CallBriefResult =
  | { ok: true; variables: CallBriefVariables }
  | { ok: false; reason: "missing_quantity" | "missing_order_reference" };

function formatDeadline(iso: string | null, timeZone: string): string {
  if (!iso) return "as soon as possible";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "as soon as possible";
  return new Intl.DateTimeFormat("en-US", { timeZone, dateStyle: "full" }).format(date);
}

/**
 * Builds the call brief passed as ElevenLabs dynamic variables. Inputs are deterministic case facts.
 * Deliberately has no access to prices, budgets or negotiation ceilings, so it cannot disclose them.
 */
export function buildCallBrief(input: {
  actionId: string;
  context: VoiceCallContext;
  payload: SupplierCallPayload;
}): CallBriefResult {
  const { context, payload } = input;
  const facts = context.facts;
  const qtyNeeded = payload.qty_needed ?? facts.bridge_qty;
  if (!qtyNeeded || qtyNeeded <= 0) return { ok: false, reason: "missing_quantity" };
  const orderRefs = [...new Set(facts.order_lines.map((line) => line.po_ref))];
  if (orderRefs.length === 0) return { ok: false, reason: "missing_order_reference" };

  const questions = [...CALL_QUESTIONS, ...payload.extra_questions]
    .map((question, index) => `${index + 1}. ${question}`)
    .join("\n");

  return {
    ok: true,
    variables: {
      company_name: context.org_name,
      ai_disclosure: AI_DISCLOSURE_TEMPLATE(context.org_name),
      supplier_name: context.supplier_name,
      contact_name: context.contact_name ?? "the order contact",
      order_ref: orderRefs.join(", "),
      item_description: facts.item_description,
      item_sku: facts.item_sku,
      qty_needed: qtyNeeded,
      unit: facts.unit,
      destination: facts.destination,
      needed_by: formatDeadline(payload.needed_by ?? facts.first_shortage_at, context.org_timezone),
      allowed_tradeoffs:
        payload.allowed_tradeoffs.length > 0 ? payload.allowed_tradeoffs.join("; ") : "none beyond partial or split delivery",
      questions,
      approval_statement: OWNER_APPROVAL_STATEMENT,
      conduit_action_id: input.actionId,
    },
  };
}
