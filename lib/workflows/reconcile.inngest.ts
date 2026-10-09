import { reconcileAction } from "@/lib/actions/dispatcher";
import { serverLedger } from "@/lib/actions/server";
import { inngest } from "./client";

export const reconcileDue = inngest.createFunction(
  { id: "reconcile-due-actions", triggers: [{ cron: "* * * * *" }], concurrency: { limit: 1 } },
  async ({ step }) => {
    const due = await step.run("list", async () => {
      const deps = serverLedger();
      return (await deps.rpc("ledger_due_reconciliations", { p_limit: 50, p_now: deps.clock.now().toISOString() })) as {
        org_id: string;
        action_id: string;
      }[];
    });
    for (const item of due) {
      await step.run(`reconcile-${item.action_id}`, () => reconcileAction(serverLedger(), item.org_id, item.action_id));
    }
    return { reconciled: due.length };
  },
);

export const reconcileRequested = inngest.createFunction(
  { id: "reconcile-requested", triggers: [{ event: "action.reconcile.requested" }] },
  async ({ event, step }) => {
    const data = event.data as Record<string, string>;
    return step.run("reconcile", () => reconcileAction(serverLedger(), data.org_id, data.action_id));
  },
);
