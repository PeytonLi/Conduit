import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/db/service";
import type { MembershipRole } from "./derive";
import { QueryError } from "./client";

export interface CommandDeps {
  client?: SupabaseClient;
}

export interface ReassessInput {
  orgId: string;
  caseId: string;
  actorUserId: string;
  actorRole: MembershipRole;
  expectedVersion: number;
  reason: string;
  requestId?: string;
}

export interface SetMembershipRoleInput {
  orgId: string;
  membershipId: string;
  actorUserId: string;
  actorRole: MembershipRole;
  expectedVersion: number;
  role: MembershipRole;
  active: boolean;
  reason: string;
  requestId?: string;
}

export interface SupplierApprovalInput {
  orgId: string;
  supplierId: string;
  actorUserId: string;
  actorRole: MembershipRole;
  scope: "contact" | "purchasing";
  contactId: string | null;
  decision: "approve" | "block" | "revoke";
  expectedVersion: number;
  reason: string;
  requestId?: string;
}

export interface ReassessResult {
  event_id: string;
  status: "queued";
}

export interface MembershipRoleResult {
  membership_id: string;
  row_version: number;
  role: MembershipRole;
  active: boolean;
}

export interface SupplierApprovalResult {
  supplier_id: string;
  contact_id: string | null;
  scope: "contact" | "purchasing";
  decision: "approve" | "block" | "revoke";
  row_version: number;
  purchasing_status: string | null;
}

const safeMessages: Record<string, string> = {
  role_denied: "Your role cannot make this change",
  owner_required: "An owner is required to accept financial risk",
  case_not_found: "Case not found",
  membership_not_found: "Membership not found",
  supplier_not_found: "Supplier not found",
  contact_not_found: "Supplier contact not found",
  stale_version: "The record changed; refresh and try again",
  idempotency_conflict: "Idempotency-Key was already used for another request",
  invalid_transition: "This change is not allowed in the current state",
  uncertain_action: "The case has an action with an uncertain result",
  outcome_unknown: "Resolve the uncertain action before resuming",
  active_case_exists: "Another active case already exists for this item and location",
  last_owner: "The organization must retain at least one active owner",
  invalid_assignee: "Assignee must be an active member of this organization",
  reason_required: "A reason is required",
  delivered_requires_receipt: "A case can be marked delivered only after a receipt is recorded",
  invalid_outcome: "Close outcome is invalid",
  invalid_command: "Control command is invalid",
  invalid_decision: "Supplier decision is invalid",
  invalid_scope: "Supplier approval scope is invalid",
  identity_evidence_required: "Identity evidence is required to approve this contact",
  channel_not_permitted: "The contact has not permitted this channel",
};

export function mapRpcError(error: { code?: string; message?: string }): QueryError {
  const message = error.message ?? "";
  const detail = Object.keys(safeMessages).find((key) => message.includes(key));
  const code = detail ?? "command_failed";
  const status =
    error.code === "P0404"
      ? 404
      : error.code === "P0403"
        ? 403
        : error.code === "P0422"
          ? 422
          : error.code === "P0409"
            ? 409
            : 503;
  return new QueryError(code, status, safeMessages[code] ?? "The requested change could not be completed");
}

async function rpc<T>(
  name: string,
  args: Record<string, unknown>,
  deps: CommandDeps,
): Promise<T> {
  const client = deps.client ?? createServiceClient();
  const result = await (client as SupabaseClient).rpc(name as never, args as never);
  if (result.error) throw mapRpcError(result.error);
  return result.data as T;
}

export interface ReassessArgs extends ReassessInput {
  requestId?: string;
}

export async function requestReassess(
  input: ReassessInput,
  deps: CommandDeps = {},
): Promise<ReassessResult> {
  if (input.actorRole === "viewer") {
    throw new QueryError("role_denied", 403, "Your role cannot request reassessment");
  }
  const result = await rpc<{ event_id: string }>(
    "ui_request_reassess",
    {
      p_org: input.orgId,
      p_case: input.caseId,
      p_actor: input.actorUserId,
      p_expected_version: input.expectedVersion,
      p_reason: input.reason,
      p_request_id: input.requestId ?? randomUUID(),
    },
    deps,
  );
  return { event_id: result.event_id, status: "queued" };
}

export async function setMembershipRole(
  input: SetMembershipRoleInput,
  deps: CommandDeps = {},
): Promise<MembershipRoleResult> {
  if (input.actorRole !== "owner") {
    throw new QueryError("owner_required", 403, "An owner is required to change membership roles");
  }
  return rpc(
    "ui_set_membership_role",
    {
      p_org: input.orgId,
      p_membership: input.membershipId,
      p_actor: input.actorUserId,
      p_expected_version: input.expectedVersion,
      p_role: input.role,
      p_active: input.active,
      p_reason: input.reason,
      p_request_id: input.requestId ?? randomUUID(),
    },
    deps,
  );
}

export async function supplierApproval(
  input: SupplierApprovalInput,
  deps: CommandDeps = {},
): Promise<SupplierApprovalResult> {
  if (input.actorRole !== "owner") {
    throw new QueryError("owner_required", 403, "An owner is required to approve suppliers");
  }
  return rpc(
    "ui_supplier_approval",
    {
      p_org: input.orgId,
      p_supplier: input.supplierId,
      p_actor: input.actorUserId,
      p_scope: input.scope,
      p_contact: input.contactId,
      p_decision: input.decision,
      p_expected_version: input.expectedVersion,
      p_reason: input.reason,
      p_request_id: input.requestId ?? randomUUID(),
    },
    deps,
  );
}
