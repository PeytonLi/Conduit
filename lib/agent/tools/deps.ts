import { z } from "zod";
import type { Clock } from "@/lib/agent/clock";
import type { PlannerStore } from "@/lib/agent/store";
import type { ActionPreparer } from "@/lib/agent/ports";
import type { SupplierResearch } from "@/lib/integrations/exa/client";
import { DEFAULT_LIMITS, type PlannerLimits } from "@/lib/agent/budgets";
import type { ToolResult } from "./types";

export interface ToolDeps {
  store: PlannerStore;
  clock: Clock;
  preparer?: ActionPreparer;
  research?: SupplierResearch;
  limits?: PlannerLimits;
}

export function limitsOf(deps: ToolDeps): PlannerLimits {
  return deps.limits ?? DEFAULT_LIMITS;
}

export function fail<O>(code: string, safeMessage: string): ToolResult<O> {
  return { ok: false, code, safeMessage };
}

export function ok<O>(data: O, evidenceIds: string[] = []): ToolResult<O> {
  return { ok: true, data, evidenceIds };
}

export const uuid = z.string().uuid();
