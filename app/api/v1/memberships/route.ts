import { parseBody } from "@/lib/api/http";
import { addMemberRequestSchema } from "@/lib/db/queries/contracts";
import { addMember, listMemberships } from "@/lib/db/queries/memberships";
import { executeMutation, mutationGuard, withMembership } from "@/lib/db/queries/route-helpers";

export async function GET(): Promise<Response> {
  return withMembership(async (context) => {
    return Response.json({
      api_schema_version: 1,
      request_id: crypto.randomUUID(),
      data: await listMemberships(context),
    });
  });
}

export async function POST(request: Request): Promise<Response> {
  const guard = mutationGuard(request);
  if (guard) return guard;
  const parsed = await parseBody(request, addMemberRequestSchema);
  if (!parsed.success) return parsed.response;
  return withMembership(
    async (context) =>
      executeMutation(request, context, { email: parsed.data.email, role: parsed.data.role }, async () => ({
        data: await addMember(context, parsed.data),
        status: 201,
      })),
    ["owner"],
  );
}
