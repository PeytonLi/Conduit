import { fail } from "@/lib/api/http";
import { executeMutation, mutationGuard, withMembership } from "@/lib/db/queries/route-helpers";
import { disconnectErpConnection } from "@/lib/integrations/business/live/connections";
import { isErpProvider } from "@/lib/integrations/business/live/registry";

export async function DELETE(request: Request): Promise<Response> {
  const guard = mutationGuard(request);
  if (guard) return guard;
  const provider = new URL(request.url).searchParams.get("provider");
  if (provider !== null && !isErpProvider(provider)) {
    return fail("validation_failed", "Unknown business system", 422, false);
  }
  return withMembership(
    async (context) =>
      executeMutation(request, context, { provider }, async () => ({
        data: await disconnectErpConnection({
          orgId: context.orgId,
          actorUserId: context.userId,
          provider: provider ?? undefined,
        }),
      })),
    ["owner"],
  );
}
