import { registerAdapter } from "@/lib/actions/adapters";
import type { ActionRecord } from "@/lib/actions/types";
import { createServiceClient } from "@/lib/db/service";
import { supabaseRpcClient } from "@/lib/db/messages";
import { parseServerEnv } from "@/lib/env";
import {
  createSupplierEmailAdapter,
  supplierEmailPayloadSchema,
  type ContactRecord,
} from "@/lib/integrations/gmail/outbound";
import { createReplayTransport } from "@/lib/integrations/gmail/replay";
import {
  FALLBACK_FROM_ADDRESS,
  resolveMailboxTransport,
  type ResolvedMailboxTransport,
} from "@/lib/integrations/mailbox/resolve";
import type { SupplierEmailTransport } from "@/lib/integrations/mailbox/transport";

// Sandbox/live supplier_email adapter registration. It serves every mailbox
// provider (Gmail and Outlook): the connection named in the action payload
// decides which transport sends. Replay dispatch is owned by F5's
// replay-outreach adapter (resolveAdapterForMode routes mode==='replay' to
// getReplayAdapter); the internal replay guard in outbound.ts is
// defense-in-depth only. Registration is lazy: no env, DB, or network access
// happens at import time — only inside dispatch/findResult calls.
let registered = false;

export function ensureSupplierEmailAdapter(): void {
  if (registered) return;
  registered = true;

  const resolveForAction = async (
    action: ActionRecord,
  ): Promise<ResolvedMailboxTransport | null> => {
    const parsed = supplierEmailPayloadSchema.safeParse(action.payload);
    if (!parsed.success) return null;
    return resolveMailboxTransport({
      rpc: supabaseRpcClient(createServiceClient()),
      env: parseServerEnv(process.env),
      // Org-scoped: a connection_id outside action.orgId resolves to nothing.
      orgId: action.orgId,
      connectionId: parsed.data.connection_id,
    });
  };

  registerAdapter(
    createSupplierEmailAdapter({
      appEnv: () => parseServerEnv(process.env).APP_ENV,
      loadContact: async (orgId, contactId): Promise<ContactRecord | null> => {
        const client = createServiceClient();
        const { data } = await client
          .from("supplier_contacts")
          .select(
            "normalized_address,outreach_approved_at,permitted_channels,supplier_id,channel",
          )
          .eq("org_id", orgId)
          .eq("id", contactId)
          .maybeSingle();
        if (!data || data.channel !== "email") return null;
        return {
          normalized_address: data.normalized_address,
          outreach_approved_at: data.outreach_approved_at,
          permitted_channels: data.permitted_channels ?? [],
          supplier_id: data.supplier_id,
        };
      },
      transportFor: async (action): Promise<SupplierEmailTransport | null> =>
        (await resolveForAction(action))?.transport ?? null,
      fromAddressFor: async (action): Promise<string> => {
        if (
          action.mode === "replay" ||
          parseServerEnv(process.env).APP_ENV === "replay"
        ) {
          return FALLBACK_FROM_ADDRESS;
        }
        return (await resolveForAction(action))?.fromAddress ?? FALLBACK_FROM_ADDRESS;
      },
      replayTransport: createReplayTransport(),
    }),
  );
}

ensureSupplierEmailAdapter();
