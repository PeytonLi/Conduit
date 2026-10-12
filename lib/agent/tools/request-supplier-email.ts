import { z } from "zod";
import {
  QUOTE_FIELDS,
  type SupplierEmailPayload,
} from "@/lib/integrations/gmail/outbound";
import type { AgentTool } from "./types";
import { fail, limitsOf, ok, uuid, type ToolDeps } from "./deps";

const PURPOSES = [
  "availability_request",
  "written_confirmation",
  "follow_up",
] as const;
const REQUIRED_FIELDS = [
  "quantity",
  "arrival",
  "freight",
  "split_delivery",
  "quote_validity",
  "order_cutoff",
  "written_confirmation",
] as const;
type RequiredField = (typeof REQUIRED_FIELDS)[number];
type QuoteField = (typeof QUOTE_FIELDS)[number];

const QUOTE_FIELD_MAP: Partial<Record<RequiredField, QuoteField>> = {
  quantity: "quantity_available",
  arrival: "arrival_date",
  freight: "freight",
  quote_validity: "valid_until",
};

const QUESTION_MAP: Partial<Record<RequiredField, string>> = {
  split_delivery: "whether a split delivery is possible",
  order_cutoff: "the latest order cutoff for that arrival",
  written_confirmation: "written confirmation of the delivery date",
};

interface Input {
  contact_id: string;
  purpose: (typeof PURPOSES)[number];
  required_fields: (typeof REQUIRED_FIELDS)[number][];
}

export function createRequestSupplierEmailTool(
  deps: ToolDeps,
): AgentTool<Input, unknown> {
  return {
    name: "request_supplier_email",
    spanName: "action_prep",
    description:
      "Prepare (never dispatch) a supplier outreach email action to an approved contact.",
    input: z
      .object({
        contact_id: uuid,
        purpose: z.enum(PURPOSES),
        required_fields: z.array(z.enum(REQUIRED_FIELDS)).min(1).max(7),
      })
      .strict(),
    async run(ctx, input) {
      const limits = limitsOf(deps);
      const c = await deps.store.getCase(ctx.orgId, ctx.caseId);
      if (!c) return fail("not_found", "case not found");
      const contact = await deps.store.getContact(ctx.orgId, input.contact_id);
      if (!contact) return fail("not_found", "contact not found");
      if (contact.channel !== "email" || !contact.permitted_channels.includes("email")) {
        return fail("channel_not_permitted", "email channel not permitted for contact");
      }
      if (!contact.outreach_approved_at) {
        return fail("not_approved", "contact outreach not approved");
      }
      const supplier = await deps.store.getSupplier(ctx.orgId, contact.supplier_id);
      if (!supplier || supplier.purchasing_status !== "approved") {
        return fail("not_approved", "supplier not approved for outreach");
      }

      // Outreach budgets are per episode — only count this episode's actions.
      const actions = (await deps.store.listActions(ctx.orgId, ctx.caseId)).filter(
        (a) => (a.episode ?? a.payload?.episode) === c.episode,
      );
      const emailsToSupplier = actions.filter(
        (a) => a.kind === "supplier_email" && a.payload?.supplier_id === supplier.id,
      );
      if (emailsToSupplier.length >= limits.emailsPerSupplier) {
        return fail("budget_exhausted", "email budget exhausted for supplier");
      }
      const contacted = new Set<string>();
      for (const a of actions) {
        if (
          (a.kind === "supplier_email" || a.kind === "supplier_call") &&
          typeof a.payload?.supplier_id === "string"
        ) {
          contacted.add(a.payload.supplier_id);
        }
      }
      if (!contacted.has(supplier.id) && contacted.size >= limits.distinctSuppliersPerEpisode) {
        return fail("budget_exhausted", "distinct supplier limit reached for episode");
      }

      const assessment = await deps.store.getCurrentAssessment(ctx.orgId, ctx.caseId);
      const item = await deps.store.getItem(ctx.orgId, c.item_id);
      const location = await deps.store.getLocation(ctx.orgId, c.location_id);
      if (
        !assessment ||
        !item ||
        !location ||
        assessment.bridge_qty === null ||
        !Number.isInteger(assessment.bridge_qty) ||
        assessment.bridge_qty <= 0 ||
        !assessment.first_shortage_at
      ) {
        return fail(
          "insufficient_facts",
          "item, positive bridge quantity, shortage time, and destination location required",
        );
      }
      const timeZone = await deps.store.getOrgTimezone(ctx.orgId);
      if (!timeZone) {
        return fail("insufficient_facts", "organization business timezone unavailable");
      }
      const connectionId = await deps.store.getActiveGmailConnectionId(ctx.orgId);
      if (!connectionId) {
        return fail("channel_unavailable", "no connected Gmail account");
      }

      const template =
        input.purpose === "written_confirmation"
          ? "delivery_confirmation"
          : "quote_request";
      const quoteFieldSet = new Set<QuoteField>();
      if (template === "quote_request") quoteFieldSet.add("unit_price");
      for (const field of input.required_fields) {
        const mapped = QUOTE_FIELD_MAP[field];
        if (mapped) quoteFieldSet.add(mapped);
      }
      const quoteFields = Array.from(quoteFieldSet);
      const additionalQuestions = Array.from(
        new Set(
          input.required_fields.flatMap((field) => {
            const mapped = QUESTION_MAP[field];
            return mapped ? [mapped] : [];
          }),
        ),
      );
      const question = additionalQuestions.length
        ? `Please also confirm: ${additionalQuestions.join("; ")}.`
        : "";
      const subjectPrefix =
        template === "delivery_confirmation"
          ? "Delivery confirmation"
          : "Availability request";
      const subject = `${subjectPrefix}: ${item.description} (${item.sku})`.slice(
        0,
        200,
      );
      const neededByLocal = new Intl.DateTimeFormat("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
        timeZone,
      }).format(new Date(assessment.first_shortage_at));
      const specification = Object.fromEntries(
        Object.entries(item.specification).filter(
          (entry): entry is [string, string | number] =>
            typeof entry[1] === "string" || typeof entry[1] === "number",
        ),
      );
      const payload: SupplierEmailPayload = {
        template,
        connection_id: connectionId,
        contact_id: contact.id,
        to: contact.normalized_address,
        subject,
        thread: null,
        facts: {
          item_sku: item.sku,
          item_description: item.description,
          specification,
          quantity: assessment.bridge_qty,
          unit: item.base_unit,
          destination_name: location.name,
          needed_by_local: neededByLocal,
          quote_fields: quoteFields,
        },
        question,
        supplier_id: supplier.id,
        episode: c.episode,
        purpose: input.purpose,
      };
      const prepared = await deps.preparer.prepare({
        orgId: ctx.orgId,
        caseId: ctx.caseId,
        kind: "supplier_email",
        idempotencyKey: `${ctx.caseId}:${c.episode}:email:${contact.id}:${input.purpose}`,
        contactId: contact.id,
        payload,
      });
      if (!prepared.ok) return fail(prepared.code, prepared.safeMessage);
      return ok({
        action_id: prepared.actionId,
        state: prepared.state,
        created: prepared.created,
      });
    },
  } as AgentTool<Input, unknown>;
}
