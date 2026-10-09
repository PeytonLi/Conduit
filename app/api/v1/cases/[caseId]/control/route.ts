import { withMembership, mutationGuard, executeMutation } from "../../../_lib";
import { parseBody } from "@/lib/api/http";
import { caseControlRequestSchema } from "@/lib/db/queries/contracts";
import { applyCaseControl } from "@/lib/db/queries/case-control";

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
      return executeMutation(request, context, parsed.data, async (requestId) => ({
        data: await applyCaseControl({
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
        }),
      }));
    },
    ["owner", "operator"],
  );
}
