import type { SupplierResearch } from "@/lib/integrations/exa/client";
import type { ActionKind, ActionState } from "@/lib/schemas/enums";
import type { ProjectionInput, ProjectionResult } from "@/lib/domain/types";
import { projectInventory } from "@/lib/domain/inventory";
import type { PlannerStore } from "./store";

export type { SupplierResearch };

export interface PreparedAction {
  actionId: string;
  state: ActionState;
  created: boolean;
}

export interface ActionPreparer {
  prepare(input: {
    orgId: string;
    caseId: string;
    kind: ActionKind;
    idempotencyKey: string;
    payload: Record<string, unknown>;
    mode: "replay" | "sandbox" | "live";
  }): Promise<PreparedAction>;
}

/** Default F3 preparer: inserts a 'prepared' action record via the store. */
export function createActionPreparer(store: PlannerStore): ActionPreparer {
  return {
    async prepare(input) {
      const { action, created } = await store.prepareAction(input);
      return { actionId: action.id, state: action.state, created };
    },
  };
}

export type InventoryProjector = (input: ProjectionInput) => ProjectionResult;

export const defaultProjector: InventoryProjector = (input) =>
  projectInventory(input);
