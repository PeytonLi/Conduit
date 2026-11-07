import { createServiceRpc } from "@/lib/actions/rpc.supabase";
import { fail } from "@/lib/api/http";
import { executeMutation, mutationGuard, withMembership } from "@/lib/db/queries/route-helpers";
import { requestErpSync } from "@/lib/integrations/business/live/connections";
import { loadErpConnection } from "@/lib/integrations/business/live/resolve";

export async function POST(request: Request): Promise<Response> {
  const guard = mutationGuard(request);
  if (guard) return guard;
  return withMembership(
    async (context) => {
      const loaded = await loadErpConnection(createServiceRpc(), context.orgId);
      if (!loaded) return fail("not_connected", "No business system is connected", 409, false);
      return executeMutation(request, context, {}, async () => {
        await requestErpSync(context.orgId, loaded.connection.connectionId);
        return { data: { requested: true, provider: loaded.connection.provider }, status: 202 };
      });
    },
    ["owner", "operator"],
  );
}
