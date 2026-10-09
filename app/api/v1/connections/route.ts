import { withMembership } from "../_lib";
import { listConnections } from "@/lib/db/queries/connections";

export async function GET(): Promise<Response> {
  return withMembership(async (context) => {
    return Response.json({
      api_schema_version: 1,
      request_id: crypto.randomUUID(),
      data: await listConnections(context),
    });
  });
}
