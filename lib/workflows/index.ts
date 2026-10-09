import type { InngestFunction } from "inngest";
import { inngest } from "./client";
import "@/lib/integrations/register-providers";
import { dispatchOnActionPrepared, executeOnPlanApproved } from "./execution.inngest";
import { monitorReceipts } from "./monitoring.inngest";
import { outboxDrain } from "./outbox.inngest";
import { reconcileDue, reconcileRequested } from "./reconcile.inngest";
import { voiceStaleCallSweep } from "./voice-call";

export const functions: InngestFunction.Any[] = [
  voiceStaleCallSweep,
  outboxDrain,
  executeOnPlanApproved,
  dispatchOnActionPrepared,
  reconcileDue,
  reconcileRequested,
  monitorReceipts,
];
export { inngest };
