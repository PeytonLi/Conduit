import { requireMembership } from "@/lib/auth";
import { getOrganization } from "@/lib/db/queries/organization";
import { listMemberships } from "@/lib/db/queries/memberships";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusBadge } from "@/components/StatusBadge";
import styles from "./billing.module.css";

export default async function BillingSettingsPage() {
  const membership = await requireMembership();
  const [organization, members] = await Promise.all([
    getOrganization(membership),
    listMemberships(membership),
  ]);
  const activeSeats = members.filter((member) => member.active).length;
  return (
    <div className={styles.page}>
      <PageHeader
        description="Pilot billing is disabled. This panel shows plan and seat information only."
        title="Billing"
      />
      <Card className={styles.panel}>
        <div className={styles.planHeader}>
          <div>
            <p className={styles.eyebrow}>Current plan</p>
            <h2>Pilot evaluation</h2>
          </div>
          <StatusBadge tone="neutral">Not billed</StatusBadge>
        </div>
        <p className={styles.note}>
          Conduit is not charging a subscription or per-seat fees during this pilot. No payment method is stored.
        </p>
        <dl className={styles.summary}>
          <div>
            <dt>Organization</dt>
            <dd>{organization.name}</dd>
          </div>
          <div>
            <dt>Organization id</dt>
            <dd><code>{organization.id}</code></dd>
          </div>
          <div>
            <dt>Active seats</dt>
            <dd>{activeSeats}</dd>
          </div>
          <div>
            <dt>Environment</dt>
            <dd>{organization.environment_mode}</dd>
          </div>
          <div>
            <dt>Billing status</dt>
            <dd>Pilot — no invoices generated</dd>
          </div>
        </dl>
      </Card>
    </div>
  );
}
