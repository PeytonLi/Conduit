import { google } from "googleapis";
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
import { createGoogleGmailApi, type GmailApi } from "@/lib/integrations/gmail/api";
import { decryptCredential } from "@/lib/integrations/gmail/crypto";

interface LoadedCredential {
  status: string;
  external_account_id: string | null;
  sync_cursor: string | null;
  encrypted_b64: string | null;
  key_version: string | null;
}

// Registration is intentionally lazy: no env, DB, or network access happens
// at import time — only inside dispatch/findResult calls.
let registered = false;

export function ensureSupplierEmailAdapter(): void {
  if (registered) return;
  registered = true;

  const loadCredential = async (
    action: ActionRecord,
  ): Promise<LoadedCredential | null> => {
    const parsed = supplierEmailPayloadSchema.safeParse(action.payload);
    if (!parsed.success) return null;
    const rpc = supabaseRpcClient(createServiceClient());
    try {
      // Org-scoped: a connection_id outside action.orgId is a 404.
      return await rpc.rpc<LoadedCredential>("gmail_load_credential", {
        org_id: action.orgId,
        connection_id: parsed.data.connection_id,
      });
    } catch {
      return null;
    }
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
      transportFor: async (action): Promise<GmailApi | null> => {
        const env = parseServerEnv(process.env);
        if (
          !env.GOOGLE_CLIENT_ID ||
          !env.GOOGLE_CLIENT_SECRET ||
          !env.GOOGLE_REDIRECT_URI ||
          !env.CREDENTIAL_ENCRYPTION_KEY
        ) {
          return null;
        }
        const cred = await loadCredential(action);
        if (
          !cred ||
          (cred.status !== "healthy" && cred.status !== "degraded") ||
          !cred.encrypted_b64 ||
          !cred.key_version
        ) {
          return null;
        }
        const refreshToken = decryptCredential(
          cred.encrypted_b64,
          env.CREDENTIAL_ENCRYPTION_KEY,
          cred.key_version,
        );
        const oauth2 = new google.auth.OAuth2(
          env.GOOGLE_CLIENT_ID,
          env.GOOGLE_CLIENT_SECRET,
          env.GOOGLE_REDIRECT_URI,
        );
        oauth2.setCredentials({ refresh_token: refreshToken });
        return createGoogleGmailApi(oauth2);
      },
      fromAddressFor: async (action): Promise<string> => {
        if (
          action.mode === "replay" ||
          parseServerEnv(process.env).APP_ENV === "replay"
        ) {
          return "inbox@conduit.local";
        }
        const cred = await loadCredential(action);
        return cred?.external_account_id ?? "inbox@conduit.local";
      },
      replayTransport: createReplayTransport(),
    }),
  );
}

ensureSupplierEmailAdapter();
