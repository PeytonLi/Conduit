import { systemClock } from "@/lib/actions/rpc";
import { createServiceRpc } from "@/lib/actions/rpc.supabase";
import { publishPending, serverLedger } from "@/lib/actions/server";
import { parseServerEnv } from "@/lib/env";
import { runConnectionSync } from "@/lib/integrations/business/live/run-sync";
import { inngest } from "./client";

const syncOne = (orgId: string, connectionId: string) =>
  runConnectionSync(
    { rpc: createServiceRpc(), clock: systemClock, encryptionKey: parseServerEnv(process.env).CREDENTIAL_ENCRYPTION_KEY },
    { orgId, connectionId },
  );

export const businessSyncRequested = inngest.createFunction(
  {
    id: "business-sync-requested",
    triggers: [{ event: "business.sync.requested" }],
    concurrency: [{ limit: 1, key: "event.data.connection_id" }],
  },
  async ({ event, step }) => {
    const data = event.data as Record<string, string>;
    const report = await step.run("sync", () => syncOne(data.org_id, data.connection_id));
    await step.run("publish", () => publishPending(serverLedger()));
    return report;
  },
);

// Every 6 hours as a backstop; connect, Settings "Sync now" and the refresh before each
// live write cover freshness, so this adds ~120 runs a month per deployment plus 1 step per connection.
export const businessSyncScheduled = inngest.createFunction(
  { id: "business-sync-scheduled", triggers: [{ cron: "0 */6 * * *" }], concurrency: { limit: 1 } },
  async ({ step }) => {
    const connections = await step.run("list", async () =>
      (await createServiceRpc()("erp_list_active_connections", {})) as { org_id: string; connection_id: string }[],
    );
    if (connections.length === 0) return { synced: 0 };
    for (const c of connections) {
      await step.run(`sync-${c.connection_id}`, () => syncOne(c.org_id, c.connection_id));
    }
    await step.run("publish", () => publishPending(serverLedger()));
    return { synced: connections.length };
  },
);
