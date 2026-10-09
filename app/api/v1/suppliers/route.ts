import { withMembership } from "@/lib/db/queries/route-helpers";
import { listSuppliers } from "@/lib/db/queries/suppliers";

export async function GET(): Promise<Response> {
  return withMembership(async (context) => {
    return Response.json({
      api_schema_version: 1,
      request_id: crypto.randomUUID(),
      data: await listSuppliers(context),
    });
  });
}
