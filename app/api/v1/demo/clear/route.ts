import { withMembership, mutationGuard, executeMutation } from "@/lib/db/queries/route-helpers";
import { clearHarborPack } from "@/lib/demo/harbor-pack";

export async function POST(request: Request): Promise<Response> {
  const guard = mutationGuard(request);
  if (guard) return guard;
  return withMembership(
    async (context) =>
      executeMutation(request, context, {}, async () => ({
        data: await clearHarborPack({ orgId: context.orgId }),
      })),
    ["owner", "operator"],
  );
}
