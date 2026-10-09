import { withMembership } from "@/lib/db/queries/route-helpers";
import { listMemberships } from "@/lib/db/queries/memberships";

export async function GET(): Promise<Response> {
  return withMembership(async (context) => {
    return Response.json({
      api_schema_version: 1,
      request_id: crypto.randomUUID(),
      data: await listMemberships(context),
    });
  });
}
