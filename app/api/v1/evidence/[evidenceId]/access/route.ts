import { withMembership } from "../../../_lib";
import { getEvidenceAccess } from "@/lib/db/queries/evidence-access";

export async function GET(
  _request: Request,
  routeContext: { params: Promise<{ evidenceId: string }> },
): Promise<Response> {
  return withMembership(async (context) => {
    const { evidenceId } = await routeContext.params;
    const data = await getEvidenceAccess(context, evidenceId);
    return Response.json({
      api_schema_version: 1,
      request_id: crypto.randomUUID(),
      data,
    });
  });
}
