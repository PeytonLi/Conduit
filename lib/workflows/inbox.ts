import { inngest } from "./client";
import { createServiceClient } from "@/lib/db/service";
import { supabaseRpcClient } from "@/lib/db/messages";
import { processSourceMessage } from "@/lib/db/cases-open";
import { syncGmailConnection } from "@/lib/integrations/gmail/sync";
import { createGoogleGmailApi } from "@/lib/integrations/gmail/api";
import { decryptCredential } from "@/lib/integrations/gmail/crypto";
import { google } from "googleapis";
import { ingestMessage } from "@/lib/db/messages";
import { parseServerEnv } from "@/lib/env";

export const inboxGmailPoll = inngest.createFunction(
  {
    id: "inbox-gmail-poll",
    triggers: [{ cron: "* * * * *" }],
    concurrency: [{ limit: 1 }],
  },
  async ({ step }) => {
    const env = parseServerEnv(process.env);
    const client = createServiceClient();
    const rpc = supabaseRpcClient(client);

    const connections = await step.run("list-connections", async () => {
      return rpc.rpc<{ org_id: string; connection_id: string }[]>(
        "inbox_list_gmail_connections",
        {},
      );
    });

    for (const conn of connections) {
      await step.run(`sync-${conn.connection_id}`, async () => {
        const cred = await rpc.rpc<{
          encrypted_b64: string | null;
          key_version: string | null;
          sync_cursor: string | null;
        }>("gmail_load_credential", {
          org_id: conn.org_id,
          connection_id: conn.connection_id,
        });
        if (!cred.encrypted_b64 || !cred.key_version || !env.CREDENTIAL_ENCRYPTION_KEY) {
          return { ok: false, reason: "missing credential" };
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
        const api = createGoogleGmailApi(oauth2);
        return syncGmailConnection({
          orgId: conn.org_id,
          connectionId: conn.connection_id,
          api,
          now: () => new Date(),
          store: {
            getCursor: async () => cred.sync_cursor,
            storeMessage: async (m) => {
              const r = await ingestMessage({
                rpc,
                orgId: m.orgId,
                connectionId: m.connectionId,
                providerMessageId: m.providerMessageId,
                providerThreadId: m.providerThreadId,
                raw: m.raw,
                historical: m.historical,
                direction: m.direction,
              });
              return r.created;
            },
            setStatus: async (orgId, connectionId, status, code) => {
              await rpc.rpc("gmail_set_status", {
                org_id: orgId,
                connection_id: connectionId,
                status,
                error_code: code,
              });
            },
            advanceCursor: async (orgId, connectionId, expected, next) => {
              const r = await rpc.rpc<{ advanced: boolean }>(
                "gmail_advance_cursor",
                {
                  org_id: orgId,
                  connection_id: connectionId,
                  expected_cursor: expected,
                  new_cursor: next,
                },
              );
              return r.advanced;
            },
          },
        });
      });
    }
    return { synced: connections.length };
  },
);

export const inboxProcessMessage = inngest.createFunction(
  {
    id: "inbox-process-message",
    triggers: [{ event: "supplier.message.received" }],
    concurrency: [{ key: "event.data.message_id", limit: 1 }],
  },
  async ({ event, step }) => {
    // Event consumers reload from DB; the outbox payload is the full envelope
    // ({org_id, ..., data:{message_id}}), so read defensively.
    const raw = event.data as Record<string, unknown> & {
      data?: { message_id?: string };
    };
    const messageId = (raw.message_id ?? raw.data?.message_id) as string;
    const orgId = (raw.org_id as string) ?? "";
    const env = parseServerEnv(process.env);
    const client = createServiceClient();
    const rpc = supabaseRpcClient(client);
    return step.run("process-message", async () => {
      return processSourceMessage({
        rpc,
        orgId,
        sourceMessageId: messageId,
        mode: "auto",
        deps: { mode: env.APP_ENV },
        now: () => new Date(),
      });
    });
  },
);
