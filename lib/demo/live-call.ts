import "server-only";
import { requestOutreach } from "@/lib/actions/outreach";
import type { DispatcherDeps } from "@/lib/actions/dispatcher";
import { QueryError, type QueryContext, queryClient } from "@/lib/db/queries/client";
import { getOrganization } from "@/lib/db/queries/organization";

const DEFAULT_PURPOSE =
  "Demo call for PO-1042 CARTON-302015: need 600 by Wed; any quote is provisional until written.";

function maskPhone(address: string): string {
  const digits = address.replace(/\D/g, "");
  if (digits.length < 4) return "••••";
  return `••••${digits.slice(-4)}`;
}

function isDemoablePhone(address: string): boolean {
  const compact = address.replace(/[\s()-]/g, "");
  if (!/^\+[1-9]\d{7,14}$/.test(compact)) return false;
  // Fixture placeholder numbers are not dialable.
  if (compact.includes("555")) return false;
  return true;
}

export async function placeDemoLiveCall(
  deps: DispatcherDeps,
  context: QueryContext,
  input: { purpose?: string; caseId?: string },
): Promise<{
  case_id: string;
  action_id: string;
  contact_id: string;
  masked_phone: string;
  purpose: string;
}> {
  const organization = await getOrganization(context);
  if (organization.environment_mode === "live") {
    throw new QueryError(
      "demo_disabled",
      409,
      "Live demo calls from this page are only available in sandbox organizations",
    );
  }
  if (organization.environment_mode === "replay") {
    throw new QueryError(
      "demo_disabled",
      409,
      "Replay organizations cannot place live phone calls",
    );
  }

  const client = await queryClient(context);
  const purpose = (input.purpose?.trim() || DEFAULT_PURPOSE).slice(0, 200);

  let caseId: string;
  if (input.caseId) {
    const { data: caseRow, error } = await client
      .from("cases")
      .select("id,phase,run_control")
      .eq("org_id", context.orgId)
      .eq("id", input.caseId)
      .maybeSingle();
    if (error) {
      throw new QueryError("query_failed", 503, "Cases are temporarily unavailable");
    }
    if (!caseRow) {
      throw new QueryError("case_not_found", 404, "Case not found");
    }
    if (caseRow.phase === "closed" || caseRow.run_control !== "active") {
      throw new QueryError("case_not_active", 409, "Choose an active open case for the demo call");
    }
    caseId = caseRow.id;
  } else {
    const { data: cases, error } = await client
      .from("cases")
      .select("id,phase,run_control,updated_at")
      .eq("org_id", context.orgId)
      .neq("phase", "closed")
      .eq("run_control", "active")
      .order("updated_at", { ascending: false })
      .limit(5);
    if (error) {
      throw new QueryError("query_failed", 503, "Cases are temporarily unavailable");
    }
    const preferred =
      cases?.find((row) =>
        ["recovering", "awaiting_supplier", "assessing", "awaiting_approval"].includes(row.phase),
      ) ?? cases?.[0];
    if (!preferred) {
      throw new QueryError(
        "case_not_found",
        404,
        "Load a Harbor Pack demo scenario first, then place the call",
      );
    }
    caseId = preferred.id;
  }

  const { data: contacts, error: contactError } = await client
    .from("supplier_contacts")
    .select("id,normalized_address,outreach_approved_at,permitted_channels")
    .eq("org_id", context.orgId)
    .eq("channel", "phone")
    .order("outreach_approved_at", { ascending: false, nullsFirst: false });
  if (contactError) {
    throw new QueryError("query_failed", 503, "Supplier contacts are temporarily unavailable");
  }
  const contact = (contacts ?? []).find(
    (row) =>
      Boolean(row.outreach_approved_at) &&
      Array.isArray(row.permitted_channels) &&
      row.permitted_channels.includes("phone") &&
      isDemoablePhone(String(row.normalized_address ?? "")),
  );
  if (!contact) {
    throw new QueryError(
      "contact_not_ready",
      409,
      "Approve a real E.164 phone contact for outreach before placing a live demo call",
    );
  }

  const result = await requestOutreach(deps, {
    orgId: context.orgId,
    caseId,
    userId: context.userId,
    idempotencyKey: crypto.randomUUID(),
    body: {
      contact_id: contact.id,
      channel: "phone",
      message: { body: purpose },
    },
  });
  if (!result.ok) {
    throw new QueryError(result.code, 422, result.message || "Could not prepare the demo call");
  }
  if (result.result === "draft") {
    const denials = (result.denials ?? []).join(", ") || "policy denied";
    throw new QueryError("outreach_denied", 409, `Call was not dispatched (${denials})`);
  }

  return {
    case_id: caseId,
    action_id: result.action.id,
    contact_id: contact.id,
    masked_phone: maskPhone(String(contact.normalized_address)),
    purpose,
  };
}
