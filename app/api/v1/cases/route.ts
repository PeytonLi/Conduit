import { withMembership, parseQuery } from "../_lib";
import { caseListQuerySchema } from "@/lib/db/queries/contracts";
import { listCases } from "@/lib/db/queries/cases";
import { systemClock } from "@/lib/db/queries/clock";

export async function GET(request: Request): Promise<Response> {
  return withMembership(async (context) => {
    const parsed = parseQuery(request, caseListQuerySchema);
    if (!parsed.success) return parsed.response;
    return Response.json(
      {
        api_schema_version: 1,
        request_id: crypto.randomUUID(),
        data: await listCases(context, parsed.data, systemClock.now()),
      },
    );
  });
}
