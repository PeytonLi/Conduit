import type { GmailApi } from "@/lib/integrations/gmail/api";

/**
 * What the supplier email adapter needs from a mailbox: send one message and
 * find it again in Sent. Both Gmail and Outlook implement it, and the replay
 * transport records sends in memory.
 */
export type SupplierEmailTransport = Pick<
  GmailApi,
  "send" | "sendStructured" | "findSentByRfcMessageId"
>;
