import { withMembership, mutationGuard, executeMutation } from "../../../_lib";
import { parseBody } from "@/lib/api/http";
import { reassessRequestSchema } from "@/lib/db/queries/contracts";
import { requestReassess } from "@/lib/db/queries/commands";

export async function POST(
  request: Request,
  routeContext: { params: Promise<{ caseId: string }> },
): Promise<Response> {
  const guard = mutationGuard(request);
  if (guard) return guard;
  const parsed = await parseBody(request, reassessRequestSchema);
  if (!parsed.success) return parsed.response;
  return withMembership(
    async (context) => {
      const { caseId } = await routeContext.params;
      return executeMutation(request, context, parsed.data, async (requestId) => ({
        data: await requestReassess({
          orgId: context.orgId,
          caseId,
          actorUserId: context.userId,
          actorRole: context.role,
          expectedVersion: parsed.data.expected_version,
          reason: parsed.data.reason,
          requestId,
        }),
        status: 202,
      }));
    },
    ["owner", "operator"],
  );
}
