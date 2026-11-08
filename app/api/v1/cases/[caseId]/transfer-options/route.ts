import { withMembership } from "@/lib/db/queries/route-helpers";
import { getTransferOptions } from "@/lib/db/queries/transfers";

export async function GET(
  _request: Request,
  routeContext: { params: Promise<{ caseId: string }> },
): Promise<Response> {
  return withMembership(async (context) => {
    const { caseId } = await routeContext.params;
    const data = await getTransferOptions(context, caseId);
    return Response.json({
      api_schema_version: 1,
      request_id: crypto.randomUUID(),
      data,
    });
  });
}
