import { fail } from "@/lib/api/http";
import {
  executeMutation,
  mutationGuard,
  withMembership,
} from "@/lib/db/queries/route-helpers";
import { createServiceClient } from "@/lib/db/service";
import { supabaseRpcClient } from "@/lib/db/messages";
import { parseServerEnv } from "@/lib/env";
import {
  disconnectMailboxConnection,
  mailboxConnectionIdSchema,
} from "@/lib/integrations/mailbox/connections";

/** Disconnects one mailbox connection (Gmail or Outlook) of the caller's organization. */
export async function DELETE(
  request: Request,
  routeContext: { params: Promise<{ connectionId: string }> },
): Promise<Response> {
  const guard = mutationGuard(request);
  if (guard) return guard;
  const { connectionId } = await routeContext.params;
  const parsed = mailboxConnectionIdSchema.safeParse(connectionId);
  if (!parsed.success) {
    return fail("validation_failed", "Mailbox connection id is invalid", 422, false);
  }
  return withMembership(
    async (context) =>
      executeMutation(request, context, { connection_id: parsed.data }, async () => ({
        data: await disconnectMailboxConnection({
          rpc: supabaseRpcClient(createServiceClient()),
          env: parseServerEnv(process.env),
          orgId: context.orgId,
          actorUserId: context.userId,
          connectionId: parsed.data,
        }),
      })),
    ["owner"],
  );
}
