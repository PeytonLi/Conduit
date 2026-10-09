import { withMembership } from "@/lib/db/queries/route-helpers";
import { getCaseDetail } from "@/lib/db/queries/cases";
import { systemClock } from "@/lib/db/queries/clock";

export async function GET(
  _request: Request,
  routeContext: { params: Promise<{ caseId: string }> },
): Promise<Response> {
  return withMembership(async (context) => {
    const { caseId } = await routeContext.params;
    const data = await getCaseDetail(context, caseId, systemClock.now());
    return Response.json({
      api_schema_version: 1,
      request_id: crypto.randomUUID(),
      data,
    });
  });
}
