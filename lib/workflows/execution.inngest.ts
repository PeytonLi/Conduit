import { dispatchAction } from "@/lib/actions/dispatcher";
import { executeApprovedPlan } from "@/lib/actions/plans";
import { publishPending, serverLedger } from "@/lib/actions/server";
import { inngest } from "./client";
import { consumeOnce } from "./outbox";

type Data = Record<string, string>;

export const executeOnPlanApproved = inngest.createFunction(
  { id: "execution-plan-approved", triggers: [{ event: "plan.approved" }] },
  async ({ event, step }) => {
    const data = event.data as Data;
    const fresh = await step.run("dedupe", () =>
      consumeOnce(serverLedger().rpc, "execution.plan_approved", data.org_id, data.event_id),
    );
    if (!fresh) return { status: "duplicate" };
    // Safe to retry: prepare is idempotent per plan step and dispatch reads the ledger first.
    const result = await step.run("execute", () =>
      executeApprovedPlan(serverLedger(), { orgId: data.org_id, planId: data.plan_id, approvalId: data.approval_id }),
    );
    await step.run("publish", () => publishPending(serverLedger()));
    return result;
  },
);

export const dispatchOnActionPrepared = inngest.createFunction(
  { id: "execution-action-prepared", triggers: [{ event: "action.prepared" }] },
  async ({ event, step }) => {
    const data = event.data as Data;
    const report = await step.run("dispatch", () => dispatchAction(serverLedger(), data.org_id, data.action_id));
    await step.run("publish", () => publishPending(serverLedger()));
    return report;
  },
);
