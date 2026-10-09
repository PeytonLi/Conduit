import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/db/service";
import type { MembershipRole } from "./derive";
import { mapRpcError } from "./commands";
import { QueryError } from "./client";

export interface CaseControlInput {
  orgId: string;
  caseId: string;
  actorUserId: string;
  actorRole: MembershipRole;
  command: "pause" | "resume" | "assign" | "close" | "reopen";
  expectedVersion: number;
  reason?: string;
  assigneeUserId?: string | null;
  outcome?: "no_impact" | "accepted_risk" | "cancelled" | "unresolved" | "delivered";
  requestId?: string;
}

export interface CaseControlResult {
  case_id: string;
  row_version: number;
  phase: string;
  run_control: string;
}

export interface CaseControlDeps {
  client?: SupabaseClient;
}

export async function applyCaseControl(
  input: CaseControlInput,
  deps: CaseControlDeps = {},
): Promise<CaseControlResult> {
  if (input.actorRole === "viewer") {
    throw new QueryError(
      "role_denied",
      403,
      "Your role cannot control this case",
    );
  }
  const client = deps.client ?? createServiceClient();
  const { data, error } = await (client as SupabaseClient).rpc(
    "ui_case_control" as never,
    {
      p_org: input.orgId,
      p_case: input.caseId,
      p_actor: input.actorUserId,
      p_actor_role: input.actorRole,
      p_command: input.command,
      p_expected_version: input.expectedVersion,
      p_reason: input.reason ?? null,
      p_assignee: input.assigneeUserId ?? null,
      p_outcome: input.outcome ?? null,
      p_request_id: input.requestId ?? randomUUID(),
    } as never,
  );
  if (error) throw mapRpcError(error);
  return data as CaseControlResult;
}
