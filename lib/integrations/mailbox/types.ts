import { z } from "zod";

/** Providers that can act as an organization's supplier mailbox. */
export const MAILBOX_PROVIDERS = ["gmail", "outlook"] as const;
export type MailboxProvider = (typeof MAILBOX_PROVIDERS)[number];

export const mailboxProviderSchema = z.enum(MAILBOX_PROVIDERS);

export function isMailboxProvider(value: string): value is MailboxProvider {
  return (MAILBOX_PROVIDERS as readonly string[]).includes(value);
}

const ACTIVE_STATUSES = new Set(["healthy", "degraded"]);

/** A connection that can still read and send mail. */
export function isActiveMailboxStatus(status: string): boolean {
  return ACTIVE_STATUSES.has(status);
}

export interface MailboxConnectionRow {
  id: string;
  org_id: string;
  provider: string;
  status: string;
  is_primary: boolean;
  created_at: string;
}

export interface ResolvedMailbox {
  id: string;
  provider: MailboxProvider;
  isPrimary: boolean;
}

/**
 * Chooses the mailbox for an outbound supplier email.
 *
 * - With `requestedId`, only that exact connection qualifies: it must belong
 *   to `orgId`, be a mailbox, and be healthy or degraded. There is no silent
 *   fallback to another mailbox; sending from a different address than the one
 *   asked for is not a safe substitution.
 * - Without it, the organization's active primary wins, then the oldest active
 *   mailbox.
 *
 * Pure so the in-memory store, the Supabase store and tests share one rule.
 */
export function pickMailboxConnection(
  rows: readonly MailboxConnectionRow[],
  orgId: string,
  requestedId?: string | null,
): ResolvedMailbox | null {
  const eligible = rows.filter(
    (row) =>
      row.org_id === orgId &&
      isMailboxProvider(row.provider) &&
      isActiveMailboxStatus(row.status),
  );
  const toResolved = (row: MailboxConnectionRow): ResolvedMailbox => ({
    id: row.id,
    provider: row.provider as MailboxProvider,
    isPrimary: row.is_primary,
  });
  if (requestedId) {
    const match = eligible.find((row) => row.id === requestedId);
    return match ? toResolved(match) : null;
  }
  const primary = eligible.find((row) => row.is_primary);
  if (primary) return toResolved(primary);
  const oldest = [...eligible].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  )[0];
  return oldest ? toResolved(oldest) : null;
}
