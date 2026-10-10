import { withMembership, mutationGuard, executeMutation } from "@/lib/db/queries/route-helpers";
import { parseBody } from "@/lib/api/http";
import { caseControlRequestSchema } from "@/lib/db/queries/contracts";
import { applyCaseControl } from "@/lib/db/queries/case-control";
import { applyCaseControlEffects } from "@/lib/actions/control";
import { serverLedger } from "@/lib/actions/server";

export async function POST(
  request: Request,
  routeContext: { params: Promise<{ caseId: string }> },
): Promise<Response> {
  const guard = mutationGuard(request);
  if (guard) return guard;
  const parsed = await parseBody(request, caseControlRequestSchema);
  if (!parsed.success) return parsed.response;
  return withMembership(
    async (context) => {
      const { caseId } = await routeContext.params;
      return executeMutation(request, context, parsed.data, async (requestId) => {
        const result = await applyCaseControl({
          orgId: context.orgId,
          caseId,
          actorUserId: context.userId,
          actorRole: context.role,
          command: parsed.data.command,
          expectedVersion: parsed.data.expected_version,
          reason: parsed.data.reason,
          assigneeUserId: parsed.data.assignee_user_id,
          outcome: parsed.data.outcome,
          requestId,
        });
        let dispatchEffects: unknown;
        const effectCommand =
          parsed.data.command === "pause" ? "pause" :
          parsed.data.command === "resume" ? "resume" :
            parsed.data.command === "close" ? "cancel" : null;
        if (effectCommand) {
          try {
            const effects = await applyCaseControlEffects(serverLedger(), {
              orgId: context.orgId,
              caseId,
              command: effectCommand as "pause" | "resume" | "cancel",
              actorUserId: context.userId,
            });
            dispatchEffects = "ok" in effects && effects.ok === false
              ? { status: "unavailable", code: effects.code }
              : effects;
          } catch {
            dispatchEffects = { status: "unavailable", code: "dispatch_effects_unavailable" };
          }
        }
        return {
          data: {
            ...result,
            ...(dispatchEffects ? { dispatch_effects: dispatchEffects } : {}),
          },
        };
      });
    },
    ["owner", "operator"],
  );
}
