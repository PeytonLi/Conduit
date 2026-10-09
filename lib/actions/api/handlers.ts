import type { MembershipContext } from "@/lib/auth/membership";
import { AuthenticationError, AuthorizationError } from "@/lib/auth/membership";
import { fail, idempotencyKey, ok, parseBody } from "@/lib/api/http";
import { createPolicyRequestSchema } from "@/lib/policies/schema";
import { createPolicyVersion } from "@/lib/policies/service";
import type { MembershipRole } from "@/lib/schemas/enums";
import { z } from "zod";
import { reconcileAction, type DispatcherDeps } from "../dispatcher";
import { getAction, resolveAction } from "../ledger";
import { requestOutreach, outreachRequestSchema } from "../outreach";
import {
  approvePlan,
  approvePlanRequestSchema,
  createPlan,
  createPlanRequestSchema,
  exportPlan,
  rejectPlan,
  rejectPlanRequestSchema,
} from "../plans";
import type { LedgerFailure } from "../rpc";

export interface HandlerDeps {
  ledger: DispatcherDeps;
  auth: (roles?: readonly MembershipRole[]) => Promise<MembershipContext>;
  publish: () => Promise<void>;
}

const statusByCode: Record<string, [number, boolean]> = {
  forbidden: [403, false],
  not_found: [404, false],
  idempotency_conflict: [409, false],
  idempotency_key_required: [428, false],
  stale_version: [409, false],
  stale_fingerprint: [409, false],
  invalid_state: [409, false],
  plan_expired: [409, false],
  approval_expired: [409, false],
  approval_not_active: [409, false],
  approval_required: [409, false],
  approval_authority_revoked: [403, false],
  plan_already_executing: [409, false],
  allocation_conflict: [409, false],
  outcome_conflict: [409, false],
  precondition_failed: [409, false],
  ceiling_too_low: [422, false],
  ceiling_exceeded: [422, false],
  validation_failed: [422, false],
  multi_write_not_supported: [422, false],
  unsupported_step: [422, false],
  evidence_required: [422, false],
  receiving_evidence_missing: [409, false],
  policy_denied: [403, false],
  mode_not_allowed: [403, false],
  dispatch_paused: [409, true],
  case_not_active: [409, true],
  stale_data: [409, true],
};

export function failure(result: LedgerFailure): Response {
  const [status, retryable] = statusByCode[result.code] ?? [409, false];
  return fail(result.code, result.message, status, retryable);
}

async function guarded(
  deps: HandlerDeps,
  roles: readonly MembershipRole[],
  run: (member: MembershipContext) => Promise<Response>,
): Promise<Response> {
  let member: MembershipContext;
  try {
    member = await deps.auth(roles);
  } catch (error) {
    if (error instanceof AuthenticationError) return fail("unauthenticated", "Sign in required", 401, false);
    if (error instanceof AuthorizationError) return fail("forbidden", "Not permitted for this role", 403, false);
    throw error;
  }
  return run(member);
}

const requireKey = (request: Request) =>
  idempotencyKey(request) ?? null;
const missingKey = () => fail("idempotency_key_required", "Idempotency-Key header is required", 428, false);

export function createPlanHandler(deps: HandlerDeps, request: Request, caseId: string) {
  return guarded(deps, ["owner", "operator"], async (member) => {
    const key = requireKey(request);
    if (!key) return missingKey();
    const body = await parseBody(request, createPlanRequestSchema);
    if (!body.success) return body.response;
    const result = await createPlan(deps.ledger, { orgId: member.orgId, caseId, userId: member.userId, idempotencyKey: key, body: body.data });
    if (!result.ok) return failure(result);
    return ok(result, result.replayed ? 200 : 201);
  });
}

export function approvePlanHandler(deps: HandlerDeps, request: Request, planId: string) {
  return guarded(deps, ["owner"], async (member) => {
    const key = requireKey(request);
    if (!key) return missingKey();
    const body = await parseBody(request, approvePlanRequestSchema);
    if (!body.success) return body.response;
    const result = await approvePlan(deps.ledger, { orgId: member.orgId, planId, userId: member.userId, idempotencyKey: key, body: body.data });
    if (!result.ok) return failure(result);
    await deps.publish();
    return ok(result);
  });
}

export function rejectPlanHandler(deps: HandlerDeps, request: Request, planId: string) {
  return guarded(deps, ["owner"], async (member) => {
    const body = await parseBody(request, rejectPlanRequestSchema);
    if (!body.success) return body.response;
    const result = await rejectPlan(deps.ledger, { orgId: member.orgId, planId, userId: member.userId, body: body.data });
    if (!result.ok) return failure(result);
    await deps.publish();
    return ok(result);
  });
}

export function exportPlanHandler(deps: HandlerDeps, request: Request, planId: string) {
  return guarded(deps, ["owner", "operator"], async (member) => {
    const key = requireKey(request);
    if (!key) return missingKey();
    const result = await exportPlan(deps.ledger, { orgId: member.orgId, planId, userId: member.userId, idempotencyKey: key });
    if (!result.ok) return failure(result);
    await deps.publish();
    return ok({ status: "manual_handoff", action: result.action, packet: result.packet, replayed: result.replayed });
  });
}

export function getActionHandler(deps: HandlerDeps, actionId: string) {
  return guarded(deps, ["owner", "operator", "viewer"], async (member) => {
    const result = await getAction(deps.ledger, member.orgId, actionId);
    if (!result.ok) return failure(result);
    return ok({ action: result.action, claims: result.claims, approval: result.approval });
  });
}

const reconcileRequestSchema = z
  .object({
    resolution: z
      .object({
        outcome: z.enum(["confirmed", "failed"]),
        evidence_id: z.string().uuid(),
        note: z.string().trim().max(500).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export function reconcileActionHandler(deps: HandlerDeps, request: Request, actionId: string) {
  return guarded(deps, ["owner", "operator"], async (member) => {
    const body = await parseBody(request, reconcileRequestSchema);
    if (!body.success) return body.response;
    const resolution = body.data.resolution;
    if (resolution) {
      if (member.role !== "owner") return fail("forbidden", "Only an owner can resolve an action outcome", 403, false);
      const result = await resolveAction(deps.ledger, {
        orgId: member.orgId,
        actionId,
        userId: member.userId,
        outcome: resolution.outcome,
        evidenceId: resolution.evidence_id,
        note: resolution.note,
      });
      if (!result.ok) return failure(result);
      await deps.publish();
      return ok({ status: "resolved", action: result.action });
    }
    const report = await reconcileAction(deps.ledger, member.orgId, actionId);
    if (report.status === "not_found") return fail("not_found", "Action not found", 404, false);
    await deps.publish();
    return ok(report);
  });
}

export function outreachHandler(deps: HandlerDeps, request: Request, caseId: string) {
  return guarded(deps, ["owner", "operator"], async (member) => {
    const key = requireKey(request);
    if (!key) return missingKey();
    const body = await parseBody(request, outreachRequestSchema);
    if (!body.success) return body.response;
    const result = await requestOutreach(deps.ledger, { orgId: member.orgId, caseId, userId: member.userId, idempotencyKey: key, body: body.data });
    if (!result.ok) return failure(result);
    await deps.publish();
    return ok(result, result.result === "prepared_action" && !result.replayed ? 201 : 200);
  });
}

export function createPolicyHandler(deps: HandlerDeps, request: Request) {
  return guarded(deps, ["owner"], async (member) => {
    const body = await parseBody(request, createPolicyRequestSchema);
    if (!body.success) return body.response;
    const result = await createPolicyVersion(deps.ledger, {
      orgId: member.orgId,
      userId: member.userId,
      expectedVersion: body.data.expected_version,
      settings: body.data.settings,
      reason: body.data.reason,
    });
    if (!result.ok) return failure(result);
    await deps.publish();
    return ok(result, 201);
  });
}
