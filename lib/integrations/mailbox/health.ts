export type MailboxHealth = "healthy" | "delayed" | "needs_attention" | "reconnect";

export interface MailboxHealthInput {
  status: string;
  last_success_at: string | null;
}

/** A healthy mailbox that has not synced for this long is reported as delayed. */
export const MAILBOX_STALE_AFTER_MS = 30 * 60 * 1000;

/**
 * Maps a connection row to the one health label the UI shows. The poll runs
 * every ten minutes, so thirty minutes without a successful sync means at
 * least two missed ticks.
 */
export function mailboxHealth(input: MailboxHealthInput, now: Date): MailboxHealth {
  if (input.status === "expired" || input.status === "revoked") return "reconnect";
  if (input.status === "degraded") return "needs_attention";
  if (input.status !== "healthy") return "reconnect";
  if (input.last_success_at) {
    const last = new Date(input.last_success_at).getTime();
    if (Number.isFinite(last) && now.getTime() - last > MAILBOX_STALE_AFTER_MS) {
      return "delayed";
    }
  }
  return "healthy";
}

export const mailboxHealthLabel: Record<MailboxHealth, string> = {
  healthy: "Healthy",
  delayed: "Sync delayed",
  needs_attention: "Needs attention",
  reconnect: "Reconnect needed",
};
