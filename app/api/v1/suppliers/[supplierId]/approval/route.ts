import { withMembership, mutationGuard, executeMutation } from "@/lib/db/queries/route-helpers";
import { parseBody } from "@/lib/api/http";
import { supplierApprovalRequestSchema } from "@/lib/db/queries/contracts";
import { supplierApproval } from "@/lib/db/queries/commands";

export async function POST(
  request: Request,
  routeContext: { params: Promise<{ supplierId: string }> },
): Promise<Response> {
  const guard = mutationGuard(request);
  if (guard) return guard;
  const parsed = await parseBody(request, supplierApprovalRequestSchema);
  if (!parsed.success) return parsed.response;
  return withMembership(
    async (context) => {
      const { supplierId } = await routeContext.params;
      return executeMutation(request, context, parsed.data, async (requestId) => ({
        data: await supplierApproval({
          orgId: context.orgId,
          supplierId,
          actorUserId: context.userId,
          actorRole: context.role,
          scope: parsed.data.scope,
          contactId: parsed.data.contact_id ?? null,
          decision: parsed.data.decision,
          expectedVersion: parsed.data.expected_version,
          reason: parsed.data.reason,
          requestId,
        }),
      }));
    },
    ["owner"],
  );
}
