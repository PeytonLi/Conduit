import type { InngestFunction } from "inngest";
import { inngest } from "./client";
import { inboxGmailPoll, inboxProcessMessage } from "./inbox";
import "@/lib/integrations/gmail/register";
import "@/lib/integrations/elevenlabs/register";
import { dispatchOnActionPrepared, executeOnPlanApproved } from "./execution.inngest";
import { monitorReceipts } from "./monitoring.inngest";
import { outboxDrain } from "./outbox.inngest";
import { reconcileDue, reconcileRequested } from "./reconcile.inngest";
import { voiceStaleCallSweep } from "./voice-call";

export const functions: InngestFunction.Any[] = [
  inboxGmailPoll,
  inboxProcessMessage,
  voiceStaleCallSweep,
  outboxDrain,
  executeOnPlanApproved,
  dispatchOnActionPrepared,
  reconcileDue,
  reconcileRequested,
  monitorReceipts,
];
export { inngest };
