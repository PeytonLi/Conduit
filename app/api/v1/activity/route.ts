import { withMembership, parseQuery } from "@/lib/db/queries/route-helpers";
import { activityQuerySchema } from "@/lib/db/queries/contracts";
import { listActivity } from "@/lib/db/queries/activity";

export async function GET(request: Request): Promise<Response> {
  return withMembership(async (context) => {
    const parsed = parseQuery(request, activityQuerySchema);
    if (!parsed.success) return parsed.response;
    return Response.json({
      api_schema_version: 1,
      request_id: crypto.randomUUID(),
      data: await listActivity(context, parsed.data),
    });
  });
}
