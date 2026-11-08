import { StatusBadge } from "@/components/StatusBadge";
import { DisconnectMailboxButton } from "@/components/DisconnectMailboxButton";
import { MakePrimaryMailboxButton } from "@/components/MailboxControls";
import { Icon } from "@/components/ui/Icon";
import {
  mailboxHealth,
  mailboxHealthLabel,
  type MailboxHealth,
} from "@/lib/integrations/mailbox/health";
import { isActiveMailboxStatus } from "@/lib/integrations/mailbox/types";
import styles from "./integrations.module.css";

export interface MailboxListItem {
  id: string;
  provider: string;
  external_account_id: string | null;
  is_primary: boolean;
  status: string;
  last_success_at: string | null;
  last_error_message: string | null;
}

const toneByHealth: Record<MailboxHealth, "success" | "warning" | "danger"> = {
  healthy: "success",
  delayed: "warning",
  needs_attention: "warning",
  reconnect: "danger",
};

/**
 * Every mailbox connection of the organization with its own health, last sync
 * and (for owners) per-connection controls. The provider cards above stay the
 * place to add a mailbox; this list is where each one is managed.
 */
export function MailboxList({
  mailboxes,
  providerLabel,
  formatLastSynced,
  canManage,
  now,
}: {
  mailboxes: readonly MailboxListItem[];
  providerLabel: (provider: string) => string;
  formatLastSynced: (value: string | null) => string;
  canManage: boolean;
  now: Date;
}) {
  return (
    <section aria-labelledby="mailboxes-heading" className={styles.businessSection}>
      <h2 className={styles.sectionHeading} id="mailboxes-heading">Mailboxes</h2>
      <p className={styles.purpose}>
        Conduit reads supplier email from every connected mailbox. Outbound supplier email is sent from the primary mailbox unless an action names another one.
      </p>
      <ul aria-label="Connected mailboxes" className={styles.mailboxList}>
        {mailboxes.map((mailbox) => {
          const health = mailboxHealth(mailbox, now);
          const active = isActiveMailboxStatus(mailbox.status);
          const label = providerLabel(mailbox.provider);
          return (
            <li className={styles.mailboxRow} key={mailbox.id}>
              <div className={styles.cardIdentity}>
                <span aria-hidden="true" className={styles.iconTile}>
                  <Icon name="inbox" />
                </span>
                <div className={styles.mailboxText}>
                  <p className={styles.mailboxName}>{mailbox.external_account_id ?? label}</p>
                  <p className={styles.syncLine}>
                    {label} · Last synced {formatLastSynced(mailbox.last_success_at)}
                  </p>
                </div>
              </div>
              <div className={styles.mailboxBadges}>
                <StatusBadge tone={toneByHealth[health]}>{mailboxHealthLabel[health]}</StatusBadge>
                {mailbox.is_primary && active && <StatusBadge tone="info">Primary</StatusBadge>}
              </div>
              {mailbox.last_error_message && (
                <p className={`${styles.error} ${styles.mailboxError}`}>{mailbox.last_error_message}</p>
              )}
              {canManage && (
                <div className={styles.mailboxActions}>
                  {active && !mailbox.is_primary && <MakePrimaryMailboxButton connectionId={mailbox.id} />}
                  <DisconnectMailboxButton active={active} connectionId={mailbox.id} providerLabel={label} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
