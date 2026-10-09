import type { InngestFunction } from "inngest";
import { inngest } from "./client";
import { inboxGmailPoll, inboxProcessMessage } from "./inbox";
import "@/lib/integrations/gmail/register";
import "@/lib/integrations/elevenlabs/register";
import { voiceStaleCallSweep } from "./voice-call";

export const functions: InngestFunction.Any[] = [
  inboxGmailPoll,
  inboxProcessMessage,
  voiceStaleCallSweep,
];
export { inngest };
