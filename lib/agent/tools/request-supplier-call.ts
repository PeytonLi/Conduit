import { z } from "zod";
import type { AgentTool } from "./types";
import { fail, limitsOf, ok, uuid, type ToolDeps } from "./deps";

const PURPOSES = ["availability_and_split", "confirm_terms"] as const;

interface Input {
  contact_id: string;
  purpose: (typeof PURPOSES)[number];
  case_version: number;
}

function withinSupplierHours(now: Date, timezone: string): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "numeric",
    hour12: false,
  }).formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? -1);
  if (weekday === "Sat" || weekday === "Sun") return false;
  return hour >= 9 && hour < 17;
}

export function createRequestSupplierCallTool(
  deps: ToolDeps,
): AgentTool<Input, unknown> {
  return {
    name: "request_supplier_call",
    spanName: "call_request",
    description:
      "Prepare (never dispatch) a supplier call action during supplier business hours.",
    input: z
      .object({
        contact_id: uuid,
        purpose: z.enum(PURPOSES),
        case_version: z.number().int().positive(),
      })
      .strict(),
    async run(ctx, input) {
      const limits = limitsOf(deps);
      const c = await deps.store.getCase(ctx.orgId, ctx.caseId);
      if (!c) return fail("not_found", "case not found");
      if (input.case_version !== c.row_version) {
        return fail("stale_case_version", "case_version does not match current case");
      }
      const contact = await deps.store.getContact(ctx.orgId, input.contact_id);
      if (!contact) return fail("not_found", "contact not found");
      if (contact.channel !== "phone" || !contact.permitted_channels.includes("phone")) {
        return fail("channel_not_permitted", "phone channel not permitted for contact");
      }
      if (!contact.outreach_approved_at) {
        return fail("not_approved", "contact outreach not approved");
      }
      if (!contact.timezone) {
        return fail("missing_timezone", "contact timezone required for calls");
      }
      const supplier = await deps.store.getSupplier(ctx.orgId, contact.supplier_id);
      if (!supplier || supplier.purchasing_status !== "approved") {
        return fail("not_approved", "supplier not approved for outreach");
      }
      if (!withinSupplierHours(deps.clock.now(), contact.timezone)) {
        return fail("outside_supplier_hours", "outside supplier business hours");
      }

      // Outreach budgets are per episode — only count this episode's actions.
      const actions = (await deps.store.listActions(ctx.orgId, ctx.caseId)).filter(
        (a) => (a.episode ?? a.payload?.episode) === c.episode,
      );
      const calls = actions.filter((a) => a.kind === "supplier_call");
      if (calls.length >= limits.callsPerEpisode) {
        return fail("budget_exhausted", "call budget exhausted for episode");
      }
      if (
        calls.some((a) => a.payload?.supplier_id === supplier.id)
      ) {
        return fail("budget_exhausted", "call budget exhausted for supplier");
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
      const prepared = await deps.preparer.prepare({
        orgId: ctx.orgId,
        caseId: ctx.caseId,
        kind: "supplier_call",
        idempotencyKey: `${ctx.caseId}:${c.episode}:call:${contact.id}:${input.purpose}`,
        contactId: contact.id,
        payload: {
          recipient: contact.normalized_address,
          contact_id: contact.id,
          supplier_id: supplier.id,
          episode: c.episode,
          purpose: input.purpose,
          max_duration_s: limits.maxCallSeconds,
          item: item
            ? {
                sku: item.sku,
                description: item.description,
                specification: item.specification,
                base_unit: item.base_unit,
              }
            : null,
          needed_qty: assessment?.bridge_qty ?? null,
          deadline: assessment?.first_shortage_at ?? null,
        },
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
