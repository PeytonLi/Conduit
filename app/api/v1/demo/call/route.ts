import { withMembership, mutationGuard, executeMutation } from "@/lib/db/queries/route-helpers";
import { parseBody } from "@/lib/api/http";
import { demoLiveCallRequestSchema } from "@/lib/db/queries/contracts";
import { placeDemoLiveCall } from "@/lib/demo/live-call";
import { routeDeps } from "@/lib/actions/api/routes";

export async function POST(request: Request): Promise<Response> {
  const guard = mutationGuard(request);
  if (guard) return guard;
  const parsed = await parseBody(request, demoLiveCallRequestSchema);
  if (!parsed.success) return parsed.response;
  const deps = routeDeps();
  return withMembership(
    async (context) =>
      executeMutation(request, context, parsed.data, async () => {
        const data = await placeDemoLiveCall(deps.ledger, context, {
          purpose: parsed.data.purpose,
          caseId: parsed.data.case_id,
        });
        await deps.publish();
        return { data };
      }),
    ["owner"],
  );
}
