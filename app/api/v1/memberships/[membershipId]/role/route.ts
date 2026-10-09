import { withMembership, mutationGuard, executeMutation } from "@/lib/db/queries/route-helpers";
import { parseBody } from "@/lib/api/http";
import { membershipRoleRequestSchema } from "@/lib/db/queries/contracts";
import { setMembershipRole } from "@/lib/db/queries/commands";

export async function POST(
  request: Request,
  routeContext: { params: Promise<{ membershipId: string }> },
): Promise<Response> {
  const guard = mutationGuard(request);
  if (guard) return guard;
  const parsed = await parseBody(request, membershipRoleRequestSchema);
  if (!parsed.success) return parsed.response;
  return withMembership(
    async (context) => {
      const { membershipId } = await routeContext.params;
      return executeMutation(request, context, parsed.data, async (requestId) => ({
        data: await setMembershipRole({
          orgId: context.orgId,
          membershipId,
          actorUserId: context.userId,
          actorRole: context.role,
          expectedVersion: parsed.data.expected_version,
          role: parsed.data.role,
          active: parsed.data.active,
          reason: parsed.data.reason,
          requestId,
        }),
      }));
    },
    ["owner"],
  );
}
