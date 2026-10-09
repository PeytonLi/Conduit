import type { SupplierResearch } from "@/lib/integrations/exa/client";
import type { ActionKind } from "@/lib/schemas/enums";
import type { ProjectionInput } from "@/lib/domain/types";
import type { AssessmentContext, AssessmentProjection } from "@/lib/domain/assessment";
import { assessInventory } from "@/lib/domain/assessment";
import { prepareAction, type Ledger } from "@/lib/actions/ledger";

export type { SupplierResearch };

export interface PreparedAction {
  actionId: string;
  state: string;
  created: boolean;
}

export type PrepareResult =
  | { ok: true; actionId: string; state: string; created: boolean }
  | { ok: false; code: string; safeMessage: string };

export interface ActionPreparer {
  prepare(input: {
    orgId: string;
    caseId: string;
    kind: ActionKind;
    idempotencyKey: string;
    payload: Record<string, unknown>;
    contactId: string | null;
    planId?: string;
    planStepId?: string;
    approvalId?: string;
  }): Promise<PrepareResult>;
}

/** F5 ledger-backed preparer: prepares actions via ledger_prepare_action. */
export function createLedgerActionPreparer(ledger: Ledger): ActionPreparer {
  return {
    async prepare(input) {
      const result = await prepareAction(ledger, {
        orgId: input.orgId,
        actor: { type: "system", id: "planner" },
        caseId: input.caseId,
        kind: input.kind,
        payload: input.payload,
        idempotencyKey: input.idempotencyKey,
        ...(input.contactId !== null && input.contactId !== undefined
          ? { contactId: input.contactId }
          : {}),
        ...(input.planId !== undefined ? { planId: input.planId } : {}),
        ...(input.planStepId !== undefined ? { planStepId: input.planStepId } : {}),
        ...(input.approvalId !== undefined ? { approvalId: input.approvalId } : {}),
      });
      if (!result.ok) {
        let safeMessage = result.message;
        if (result.code === "policy_denied" && Array.isArray(result.denials)) {
          safeMessage = `${safeMessage} (${(result.denials as string[]).join(", ")})`;
        }
        return { ok: false, code: result.code, safeMessage };
      }
      // RPC errors propagate so the Inngest step retries — idempotency dedupes.
      return {
        ok: true,
        actionId: result.action.id,
        state: result.action.state,
        created: !result.replayed,
      };
    },
  };
}

export type InventoryAssessor = (
  input: ProjectionInput,
  context: AssessmentContext,
) => {
  projection: AssessmentProjection;
  liveCommitmentAllowed: boolean;
  missingFacts: string[];
  staleSources: string[];
};

export const defaultAssessor: InventoryAssessor = (input, context) =>
  assessInventory(input, context);
