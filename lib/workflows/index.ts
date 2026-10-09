import type { InngestFunction } from "inngest";
import { inngest } from "./client";
import { inboxGmailPoll, inboxProcessMessage } from "./inbox";
import "@/lib/integrations/gmail/register";

export const functions: InngestFunction.Any[] = [inboxGmailPoll, inboxProcessMessage];
export { inngest };
