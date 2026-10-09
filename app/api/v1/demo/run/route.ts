import { withMembership, mutationGuard, executeMutation } from "@/lib/db/queries/route-helpers";
import { parseBody } from "@/lib/api/http";
import { demoRunRequestSchema } from "@/lib/db/queries/contracts";
import { loadHarborPack } from "@/lib/demo/harbor-pack";

export async function POST(request: Request): Promise<Response> {
  const guard = mutationGuard(request);
  if (guard) return guard;
  const parsed = await parseBody(request, demoRunRequestSchema);
  if (!parsed.success) return parsed.response;
  return withMembership(
    async (context) =>
      executeMutation(request, context, parsed.data, async () => ({
        data: await loadHarborPack({
          orgId: context.orgId,
          fixtureId: parsed.data.fixture_id,
          reset: parsed.data.reset,
        }),
      })),
    ["owner", "operator"],
  );
}
