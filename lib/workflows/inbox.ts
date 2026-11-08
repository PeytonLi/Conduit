import { inngest } from "./client";
import { publishPending, serverLedger } from "@/lib/actions/server";
import { createServiceClient } from "@/lib/db/service";
import { supabaseRpcClient } from "@/lib/db/messages";
import { processSourceMessage } from "@/lib/db/cases-open";
import { gmailPollEnabled } from "@/lib/integrations/gmail/sync";
import {
  GMAIL_WATCH_RENEW_CRON,
  gmailWatchEnabled,
} from "@/lib/integrations/gmail/push";
import {
  listWatchesDue,
  registerWatchForConnection,
  syncGmailConnectionById,
} from "@/lib/integrations/gmail/runtime";
import { parseServerEnv } from "@/lib/env";
import { createDeepSeekClient } from "@/lib/agent/extraction";

export const inboxGmailPoll = inngest.createFunction(
  {
    id: "inbox-gmail-poll",
    triggers: [{ cron: "*/10 * * * *" }],
    concurrency: [{ limit: 1 }],
  },
  async ({ step }) => {
    const env = parseServerEnv(process.env);
    if (!gmailPollEnabled(env)) {
      return { skipped: true, reason: "gmail poll disabled or not configured" };
    }
    const client = createServiceClient();
    const rpc = supabaseRpcClient(client);

    const connections = await step.run("list-connections", async () => {
      return rpc.rpc<
        {
          org_id: string;
          connection_id: string;
          environment_mode: string;
        }[]
      >("inbox_list_gmail_connections", {});
    });

    for (const conn of connections) {
      if (conn.environment_mode === "replay") continue;
      await step.run(`sync-${conn.connection_id}`, () =>
        syncGmailConnectionById({
          rpc,
          env,
          orgId: conn.org_id,
          connectionId: conn.connection_id,
          publish: () => publishPending(serverLedger()),
        }),
      );
    }
    return { synced: connections.length };
  },
);

/**
 * Keeps Gmail push watches alive. users.watch expires after at most 7 days;
 * this registers new connections and renews anything close to expiry. The poll
 * above keeps running regardless, so a missed renewal only costs latency.
 */
export const inboxGmailWatchRenew = inngest.createFunction(
  {
    id: "inbox-gmail-watch-renew",
    triggers: [{ cron: GMAIL_WATCH_RENEW_CRON }],
    concurrency: [{ limit: 1 }],
  },
  async ({ step }) => {
    const env = parseServerEnv(process.env);
    if (!gmailWatchEnabled(env)) {
      return { skipped: true, reason: "gmail push disabled or not configured" };
    }
    const rpc = supabaseRpcClient(createServiceClient());

    const due = await step.run("list-due-watches", async () =>
      (await listWatchesDue({ rpc, env })).map((s) => ({
        orgId: s.orgId,
        connectionId: s.connectionId,
      })),
    );

    let renewed = 0;
    for (const conn of due) {
      const outcome = await step.run(`watch-${conn.connectionId}`, () =>
        registerWatchForConnection({
          rpc,
          env,
          orgId: conn.orgId,
          connectionId: conn.connectionId,
        }),
      );
      if (outcome.ok) renewed += 1;
    }
    return { due: due.length, renewed };
  },
);

export const inboxProcessMessage = inngest.createFunction(
  {
    id: "inbox-process-message",
    triggers: [{ event: "supplier.message.received" }],
    concurrency: [{ key: "event.data.message_id", limit: 1 }],
  },
  async ({ event, step }) => {
    const raw = event.data as { message_id: string; org_id: string };
    const messageId = raw.message_id;
    const orgId = raw.org_id;
    const env = parseServerEnv(process.env);
    const client = createServiceClient();
    const rpc = supabaseRpcClient(client);
    const result = await step.run("process-message", async () => {
      const deepseek = createDeepSeekClient(env);
      return processSourceMessage({
        rpc,
        orgId,
        sourceMessageId: messageId,
        mode: "auto",
        deps: {
          mode: env.APP_ENV,
          deepseek: deepseek ?? undefined,
          model: env.DEEPSEEK_MODEL,
        },
        now: () => new Date(),
      });
    });
    return result;
  },
);
