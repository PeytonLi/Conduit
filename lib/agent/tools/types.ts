import type { z } from "zod";

export interface AgentToolContext {
  orgId: string;
  caseId: string;
  actor: "planner" | "voice";
  correlationId: string;
  mode: "replay" | "sandbox" | "live";
}

export type ToolResult<O> =
  | { ok: true; data: O; evidenceIds: string[] }
  | { ok: false; code: string; safeMessage: string };

export interface AgentTool<I, O> {
  name: string;
  description: string;
  input: z.ZodType<I>;
  run(ctx: AgentToolContext, input: I): Promise<ToolResult<O>>;
}
