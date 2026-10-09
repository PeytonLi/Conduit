import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { type QueryContext } from "@/lib/db/queries/client";
import { getCaseDetail, getCaseEvidence, getCaseTimeline, listCases } from "@/lib/db/queries/cases";
import { applyCaseControl } from "@/lib/db/queries/case-control";
import { setMembershipRole, supplierApproval } from "@/lib/db/queries/commands";
import { withIdempotency } from "@/lib/db/queries/idempotency";
import { getEvidenceAccess } from "@/lib/db/queries/evidence-access";
import { listMemberships } from "@/lib/db/queries/memberships";
import { loadHarborPack } from "@/lib/demo/harbor-pack";
import { HARBOR_PACK_FIXTURE_CLOCK, HARBOR_PACK_ORG_ID } from "@/lib/demo/fixtures";

vi.mock("server-only", () => ({}));

const harborOrgId = HARBOR_PACK_ORG_ID;
const otherOrgId = "00000000-0000-4000-8000-000000000002";
const fixedNow = new Date(HARBOR_PACK_FIXTURE_CLOCK);

let service: SupabaseClient;
let ownerContext: QueryContext;
let operatorContext: QueryContext;
let viewerContext: QueryContext;
let otherContext: QueryContext;
let caseId: string;
let priorDatasetId: string;
let otherCaseId: string;
let otherEvidenceId: string;

function configureLocalSupabase(): void {
  const output = execFileSync("pnpm", ["exec", "supabase", "status", "-o", "env"], {
    encoding: "utf8",
  });
  const values = Object.fromEntries(
    output
      .split(/\r?\n/)
      .map((line) => line.match(/^([A-Z_]+)="?(.*?)"?$/))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .map((match) => [match[1], match[2]]),
  );
  process.env.SUPABASE_URL = values.API_URL ?? values.SUPABASE_URL;
  process.env.SUPABASE_PUBLISHABLE_KEY = values.ANON_KEY ?? values.SUPABASE_PUBLISHABLE_KEY;
  process.env.SUPABASE_SECRET_KEY = values.SERVICE_ROLE_KEY ?? values.SUPABASE_SECRET_KEY;
  process.env.APP_ENV = "replay";
}

async function userIdFor(email: string): Promise<string> {
  const { data, error } = await service.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw error;
  const user = data.users.find((entry) => entry.email === email);
  if (!user) throw new Error(`Missing seeded integration account ${email}`);
  return user.id;
}

async function membershipFor(userId: string): Promise<{ id: string; row_version: number }> {
  const { data, error } = await service.from("memberships").select("id,row_version")
    .eq("org_id", harborOrgId).eq("auth_user_id", userId).single();
  if (error) throw error;
  return data;
}

describe("F6 database/API trust boundaries", () => {
  beforeAll(async () => {
    configureLocalSupabase();
    service = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SECRET_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const loaded = await loadHarborPack({
      orgId: harborOrgId,
      fixtureId: "harbor-pack-canonical",
      reset: true,
      now: fixedNow,
    });
    caseId = loaded.case_id;
    priorDatasetId = loaded.dataset_id;
    const [ownerId, operatorId, viewerId, otherOwnerId] = await Promise.all([
      userIdFor("owner@harbor.example"),
      userIdFor("operator@harbor.example"),
      userIdFor("viewer@harbor.example"),
      userIdFor("other-owner@other.example"),
    ]);
    ownerContext = { orgId: harborOrgId, userId: ownerId, role: "owner", client: service };
    operatorContext = { orgId: harborOrgId, userId: operatorId, role: "operator", client: service };
    viewerContext = { orgId: harborOrgId, userId: viewerId, role: "viewer", client: service };
    otherContext = { orgId: otherOrgId, userId: otherOwnerId, role: "owner", client: service };
    const otherItemId = "20000000-0000-4000-8000-000000000002";
    const otherLocationId = "10000000-0000-4000-8000-000000000002";
    const { data: otherCase, error: caseError } = await service.from("cases")
      .insert({ org_id: otherOrgId, item_id: otherItemId, location_id: otherLocationId })
      .select("id").single();
    if (caseError) throw caseError;
    otherCaseId = otherCase.id;
    otherEvidenceId = randomUUID();
    const { error: evidenceError } = await service.from("evidence").insert({
      id: otherEvidenceId,
      org_id: otherOrgId,
      source_type: "email",
      content_hash: randomUUID().replaceAll("-", ""),
      private_object_path: `${otherOrgId}/${otherEvidenceId}/private.eml`,
    });
    if (evidenceError) throw evidenceError;
  });

  afterAll(async () => {
    if (service) {
      if (otherCaseId) await service.from("cases").delete().eq("id", otherCaseId).eq("org_id", otherOrgId);
      if (otherEvidenceId) await service.from("evidence").delete().eq("id", otherEvidenceId).eq("org_id", otherOrgId);
      await service.auth.signOut();
    }
  });

  describe("AT-14 role and tenant protection", () => {
    it("rejects operator risk acceptance, role changes, supplier approval, and viewer controls", async () => {
      await expect(applyCaseControl({
        orgId: harborOrgId,
        caseId,
        actorUserId: operatorContext.userId,
        actorRole: "operator",
        command: "close",
        expectedVersion: 1,
        reason: "Risk accepted",
        outcome: "accepted_risk",
      })).rejects.toMatchObject({ code: "owner_required", status: 403 });

      const ownerMembership = await membershipFor(ownerContext.userId);
      await expect(setMembershipRole({
        orgId: harborOrgId,
        membershipId: ownerMembership.id,
        actorUserId: operatorContext.userId,
        actorRole: "operator",
        expectedVersion: ownerMembership.row_version,
        role: "operator",
        active: true,
        reason: "Attempted role change",
      })).rejects.toMatchObject({ code: "owner_required", status: 403 });

      const { data: supplier, error } = await service.from("suppliers").select("id,row_version")
        .eq("org_id", harborOrgId).eq("name", "Bay Carton").single();
      if (error) throw error;
      await expect(supplierApproval({
        orgId: harborOrgId,
        supplierId: supplier.id,
        actorUserId: operatorContext.userId,
        actorRole: "operator",
        scope: "purchasing",
        contactId: null,
        decision: "approve",
        expectedVersion: supplier.row_version,
        reason: "Attempted approval",
      })).rejects.toMatchObject({ code: "owner_required", status: 403 });

      await expect(applyCaseControl({
        orgId: harborOrgId,
        caseId,
        actorUserId: viewerContext.userId,
        actorRole: "viewer",
        command: "pause",
        expectedVersion: 1,
        reason: "Viewer control attempt",
      })).rejects.toMatchObject({ code: "role_denied", status: 403 });
    });

    it("hides other-organization cases and evidence", async () => {
      await expect(getCaseDetail(ownerContext, otherCaseId, fixedNow))
        .rejects.toMatchObject({ code: "case_not_found", status: 404 });
      await expect(getEvidenceAccess(ownerContext, otherEvidenceId, fixedNow))
        .rejects.toMatchObject({ code: "evidence_file_unavailable", status: 404 });
      const { error } = await service.from("cases").delete()
        .eq("org_id", otherOrgId).eq("id", otherCaseId);
      if (error) throw error;
      otherCaseId = "";
    });

    it("never returns another organization's memberships", async () => {
      const memberships = await listMemberships(ownerContext);
      expect(memberships.length).toBeGreaterThan(0);
      expect(memberships.every((membership) => membership.user_id !== otherContext.userId)).toBe(true);
    });

    it("protects the last active owner", async () => {
      const ownerMembership = await membershipFor(ownerContext.userId);
      await expect(setMembershipRole({
        orgId: harborOrgId,
        membershipId: ownerMembership.id,
        actorUserId: ownerContext.userId,
        actorRole: "owner",
        expectedVersion: ownerMembership.row_version,
        role: "operator",
        active: false,
        reason: "Last owner protection test",
      })).rejects.toMatchObject({ code: "last_owner", status: 409 });
    });

    it("rejects stale case versions and replays identical idempotency keys", async () => {
      await expect(applyCaseControl({
        orgId: harborOrgId,
        caseId,
        actorUserId: ownerContext.userId,
        actorRole: "owner",
        command: "pause",
        expectedVersion: 9999,
        reason: "Stale version test",
      })).rejects.toMatchObject({ code: "stale_version", status: 409 });

      const key = `ui-api:${randomUUID()}`;
      let calls = 0;
      await withIdempotency(
        harborOrgId,
        key,
        "/api/v1/test",
        { action: "read-only-test" },
        async () => {
          calls += 1;
          return { status: 200, body: { value: "stable" } };
        },
        { client: service, actorUserId: ownerContext.userId },
      );
      const replay = await withIdempotency(
        harborOrgId,
        key,
        "/api/v1/test",
        { action: "read-only-test" },
        async () => {
          calls += 1;
          return { status: 201, body: { value: "wrong" } };
        },
        { client: service, actorUserId: ownerContext.userId },
      );
      expect(replay).toMatchObject({ status: 200, body: { value: "stable" }, replayed: true });
      expect(calls).toBe(1);
      await expect(withIdempotency(
        harborOrgId,
        key,
        "/api/v1/test",
        { action: "different-body" },
        async () => ({ status: 200, body: {} }),
        { client: service, actorUserId: ownerContext.userId },
      )).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
      await service.from("request_idempotency").delete()
        .eq("org_id", harborOrgId).eq("idempotency_key", key);
    });

    it("blocks closing a case while an action has an uncertain result", async () => {
      const { data: action, error: readError } = await service.from("actions")
        .select("id,state").eq("org_id", harborOrgId).eq("case_id", caseId)
        .eq("state", "confirmed").limit(1).maybeSingle();
      if (readError) throw readError;
      expect(action).not.toBeNull();
      const { error: markError } = await service.from("actions").update({ state: "unknown" })
        .eq("org_id", harborOrgId).eq("id", action!.id);
      if (markError) throw markError;
      try {
        await expect(applyCaseControl({
          orgId: harborOrgId,
          caseId,
          actorUserId: ownerContext.userId,
          actorRole: "owner",
          command: "close",
          expectedVersion: 1,
          reason: "Uncertain action test",
          outcome: "cancelled",
        })).rejects.toMatchObject({ code: "uncertain_action", status: 409 });
      } finally {
        await service.from("actions").update({ state: "confirmed" })
          .eq("org_id", harborOrgId).eq("id", action!.id);
      }
    });

    it("refuses demo loading for a live organization", async () => {
      const { error } = await service.from("organizations").update({ environment_mode: "live" })
        .eq("id", harborOrgId);
      if (error) throw error;
      try {
        await expect(loadHarborPack({
          orgId: harborOrgId,
          fixtureId: "harbor-pack-canonical",
          reset: false,
          now: fixedNow,
        })).rejects.toMatchObject({ code: "demo_disabled", status: 409 });
      } finally {
        await service.from("organizations").update({ environment_mode: "sandbox" })
          .eq("id", harborOrgId);
      }
    });

    it("resets fixtures without deleting history and leaves one active case", async () => {
      const { data: priorEvents, error: priorEventError } = await service.from("audit_events")
        .select("id").eq("org_id", harborOrgId).eq("case_id", caseId);
      if (priorEventError) throw priorEventError;
      const priorCaseId = caseId;
      const result = await loadHarborPack({
        orgId: harborOrgId,
        fixtureId: "harbor-pack-canonical",
        reset: true,
        now: fixedNow,
      });
      expect(result.case_id).not.toBe(priorCaseId);
      const { data: oldCase, error: oldCaseError } = await service.from("cases")
        .select("phase,closed_outcome,closed_reason").eq("org_id", harborOrgId)
        .eq("id", priorCaseId).single();
      if (oldCaseError) throw oldCaseError;
      expect(oldCase).toMatchObject({
        phase: "closed",
        closed_outcome: "cancelled",
        closed_reason: "Demo reset",
      });
      const { count, error: activeError } = await service.from("cases")
        .select("id", { count: "exact", head: true })
        .eq("org_id", harborOrgId)
        .eq("item_id", "20000000-0000-4000-8000-000000000001")
        .eq("location_id", "10000000-0000-4000-8000-000000000001")
        .neq("phase", "closed");
      if (activeError) throw activeError;
      expect(count).toBe(1);
      const { data: history, error: historyError } = await service.from("audit_events")
        .select("id").eq("org_id", harborOrgId).eq("case_id", priorCaseId);
      if (historyError) throw historyError;
      expect(history!.length).toBeGreaterThanOrEqual(priorEvents!.length + 1);
      const { data: oldDataset, error: datasetError } = await service.from("datasets")
        .select("status").eq("org_id", harborOrgId).eq("id", priorDatasetId).single();
      if (datasetError) throw datasetError;
      expect(oldDataset.status).toBe("superseded");
      caseId = result.case_id;
      priorDatasetId = result.dataset_id;
    });
  });

  describe("AT-28 case facts, pending decisions, sources, and deadlines", () => {
    it("exposes current assessment, pending approval, source excerpts, actor, and next deadline", async () => {
      const detail = await getCaseDetail(ownerContext, caseId, fixedNow);
      expect(detail.case.item.sku).toBe("CARTON-302015");
      expect(new Date(detail.case.first_shortage_at!).toISOString()).toBe("2026-10-14T16:00:00.000Z");
      expect(detail.case.bridge_quantity).toBe(600);
      expect(new Date(detail.case.next_action.due_at!).toISOString()).toBe("2026-10-12T19:00:00.000Z");
      expect(detail.plan).toMatchObject({
        status: "ready",
        supplier: { name: "Bay Carton" },
        approver_required: "owner",
      });
      const evidence = await getCaseEvidence(ownerContext, caseId);
      expect(evidence.some((entry) => entry.supported_excerpt?.includes("4,000 cartons"))).toBe(true);
      const timeline = await getCaseTimeline(ownerContext, caseId);
      expect(timeline.some((entry) => entry.actor.label === "harbor-pack-loader")).toBe(true);
      expect(timeline.some((entry) => entry.evidence_ids.length > 0)).toBe(true);
    });
  });

  describe("AT-42 filtered empty versus no cases", () => {
    it("returns zero matching cases with other-phase counts and distinguishes an empty org", async () => {
      const filteredEmpty = await listCases(
        ownerContext,
        { phase: ["new"], include_closed: true, limit: 25 },
        fixedNow,
      );
      expect(filteredEmpty.total_matching).toBe(0);
      expect(filteredEmpty.counts.by_phase.awaiting_approval).toBeGreaterThan(0);

      const noCases = await listCases(
        otherContext,
        { limit: 25 },
        fixedNow,
      );
      expect(noCases.total_matching).toBe(0);
      expect(Object.values(noCases.counts.by_phase).every((count) => count === 0)).toBe(true);
      expect(noCases.summary.active_cases).toBe(0);
    });
  });
});
