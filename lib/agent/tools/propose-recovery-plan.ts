import type { z } from "zod";
import { proposePlanPayloadSchema } from "../decision";
import type { AgentTool } from "./types";
import { fail, ok, type ToolDeps } from "./deps";
import { evaluateQuote } from "../quote-evaluation";

type Input = z.infer<typeof proposePlanPayloadSchema>;

export function createProposeRecoveryPlanTool(
  deps: ToolDeps,
): AgentTool<Input, unknown> {
  return {
    name: "propose_recovery_plan",
    spanName: "quote_validation",
    description:
      "Propose a versioned draft/ready recovery plan after deterministic validation. Never approves.",
    input: proposePlanPayloadSchema,
    async run(ctx, input) {
      const c = await deps.store.getCase(ctx.orgId, ctx.caseId);
      if (!c) return fail("not_found", "case not found");
      const assessment = await deps.store.getAssessmentById(
        ctx.orgId,
        ctx.caseId,
        input.assessment_id,
      );
      if (!assessment || c.current_assessment_id !== assessment.id) {
        return fail("stale_assessment", "assessment is not the case's current assessment");
      }
      const kinds = new Set(input.steps.map((s) => s.kind));
      if (kinds.has("cancel_original_quantity") && kinds.has("purchase_bridge")) {
        return fail(
          "dependent_writes",
          "cancel_original_quantity cannot be combined with purchase_bridge",
        );
      }
      const item = await deps.store.getItem(ctx.orgId, c.item_id);
      if (!item) return fail("not_found", "item not found");

      // purchase_bridge and amend_delivery_schedule REQUIRE quote_id — the
      // supplier's split/expedite offer is the quote. Transfers and cancels
      // never reference quotes.
      const quotes = new Map<string, Awaited<ReturnType<typeof deps.store.getQuote>>>();
      for (const step of input.steps) {
        if (step.kind === "purchase_bridge" || step.kind === "amend_delivery_schedule") {
          if (!step.quote_id) {
            return fail("missing_quote", `step ${step.step_id} requires a quote_id`);
          }
          const quote = await deps.store.getQuote(ctx.orgId, ctx.caseId, step.quote_id);
          if (!quote) {
            return fail("not_found", `quote ${step.quote_id} not found for this case`);
          }
          quotes.set(step.step_id, quote);
        }
      }

      // Deterministic coverage per requirement:
      // - quoted steps cover reqs with by >= the quote's arrival_end
      // - transfer_stock covers reqs with by >= arrival_by (never without it)
      // - cancel_original_quantity contributes nothing
      const requirements = assessment.dated_requirements ?? [];
      const uncovered: { by: string; cumulative_quantity: number; covered: number }[] = [];
      for (const req of requirements) {
        let covered = 0;
        for (const step of input.steps) {
          const quote = quotes.get(step.step_id);
          if (quote) {
            if (quote.arrival_end && new Date(quote.arrival_end) <= new Date(req.by)) {
              covered += step.quantity;
            }
          } else if (step.kind === "transfer_stock") {
            if (step.arrival_by && new Date(step.arrival_by) <= new Date(req.by)) {
              covered += step.quantity;
            }
          }
        }
        if (covered < req.cumulative_quantity) {
          uncovered.push({ ...req, covered });
        }
      }
      if (uncovered.length > 0) {
        return fail("insufficient_coverage", JSON.stringify(uncovered));
      }

      // Money (bigint, decimal strings out). Gross vs incremental are distinct:
      // - amend_delivery_schedule: goods already committed, so only the quote's
      //   freight + fees + tax count toward both totals
      // - purchase_bridge: full landed cost toward both totals
      // Any unknown landed component in a referenced quote => both totals null.
      const missingFields: string[] = [];
      let gross = 0n;
      let incremental = 0n;
      let anyUnknown = false;
      const has = (v: string | number | null | undefined) =>
        v !== null && v !== undefined && v !== "";
      for (const step of input.steps) {
        const quote = quotes.get(step.step_id);
        if (!quote) continue;
        if (step.kind === "amend_delivery_schedule") {
          if (
            has(quote.freight_minor) &&
            has(quote.fees_minor) &&
            has(quote.nonrecoverable_tax_minor)
          ) {
            const delta =
              BigInt(String(quote.freight_minor)) +
              BigInt(String(quote.fees_minor)) +
              BigInt(String(quote.nonrecoverable_tax_minor));
            gross += delta;
            incremental += delta;
          } else {
            anyUnknown = true;
            for (const [field, value] of [
              ["freight", quote.freight_minor],
              ["fees", quote.fees_minor],
              ["nonrecoverable_tax", quote.nonrecoverable_tax_minor],
            ] as const) {
              if (!has(value)) missingFields.push(`${step.step_id}:${field}`);
            }
          }
        } else {
          const evaln = evaluateQuote(quote, item, deps.clock.now());
          if (evaln.landed_cost_minor === null) {
            anyUnknown = true;
            missingFields.push(...evaln.missing_terms.map((t) => `${step.step_id}:${t}`));
          } else {
            const landed = BigInt(evaln.landed_cost_minor);
            gross += landed;
            incremental += landed;
          }
        }
      }
      const grossStr = anyUnknown ? null : gross.toString();
      const incrementalStr = anyUnknown ? null : incremental.toString();

      // Ready only if every referenced quote is verified, complete, unexpired —
      // and no transfer step (always unverified).
      let ready = !anyUnknown;
      for (const step of input.steps) {
        if (step.kind === "transfer_stock") {
          ready = false;
          missingFields.push(`${step.step_id}:transfer_unverified`);
        }
        const quote = quotes.get(step.step_id);
        if (!quote) continue;
        const evaln = evaluateQuote(quote, item, deps.clock.now());
        if (quote.status !== "verified" || evaln.missing_terms.length > 0 || evaln.expired) {
          ready = false;
          if (quote.status !== "verified") missingFields.push(`${step.step_id}:quote_not_verified`);
        }
      }

      // Policy ceiling check uses incremental; unknown incremental => exceeds.
      const policy = await deps.store.getCurrentPolicy(ctx.orgId);
      const ceilingRaw = (policy?.settings as Record<string, unknown> | undefined)
        ?.procurement_ceiling_minor;
      const ceiling = ceilingRaw === undefined || ceilingRaw === null ? null : BigInt(String(ceilingRaw));
      const exceeds = incrementalStr === null || ceiling === null || incremental > ceiling;

      let status = ready ? "ready" : "draft";
      let reviewRaised = false;
      if (exceeds) {
        status = "draft";
        await deps.store.insertReview({
          org_id: ctx.orgId,
          case_id: ctx.caseId,
          reason: incrementalStr === null
            ? "incremental cost unknown: quote has missing landed cost components"
            : ceiling === null
              ? "incremental cost exceeds policy: no procurement ceiling configured"
              : `incremental cost ${incrementalStr} exceeds procurement ceiling ${ceiling.toString()}`,
          missing_fields: ["procurement_ceiling_minor"],
          object_ids: [assessment.id],
          status: "open",
          created_by: "planner",
        });
        reviewRaised = true;
      }

      const version = await deps.store.nextPlanVersion(ctx.orgId, ctx.caseId);
      const plan = await deps.store.insertRecoveryPlan({
        orgId: ctx.orgId,
        caseId: ctx.caseId,
        version,
        assessmentId: assessment.id,
        status,
        grossCommitmentMinor: grossStr,
        incrementalCostMinor: incrementalStr,
        evidenceIds: input.evidence_ids,
        steps: input.steps.map((s) => ({
          ...s,
          item_id: item.id,
          unit: item.base_unit,
          missing_fields: missingFields.filter((f) => f.startsWith(`${s.step_id}:`)),
        })),
      });
      return ok(
        {
          plan_id: plan.id,
          version,
          status,
          gross_commitment_minor: grossStr,
          incremental_cost_minor: incrementalStr,
          missing_fields: [...new Set(missingFields)],
          owner_review_raised: reviewRaised,
        },
        input.evidence_ids,
      );
    },
  } as AgentTool<Input, unknown>;
}
