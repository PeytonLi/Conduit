import { requireMembership } from "@/lib/auth";
import { getCurrentPolicy } from "@/lib/db/queries/policies";
import { formatDateTime, formatMoney } from "@/lib/db/queries/format";
import { getOrganization } from "@/lib/db/queries/organization";
import { policySettingsSchema } from "@/lib/policies/schema";
import { PolicyEditor } from "@/components/PolicyEditor";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import styles from "./policies.module.css";

const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function minutes(seconds: number): string {
  const value = seconds / 60;
  return `${value} ${value === 1 ? "minute" : "minutes"}`;
}

export default async function PoliciesSettingsPage() {
  const membership = await requireMembership();
  const [policy, organization] = await Promise.all([
    getCurrentPolicy(membership),
    getOrganization(membership),
  ]);
  const settings = policySettingsSchema.parse(policy?.settings ?? {});
  const autonomousCommitmentMinor: string = settings.budgets.autonomous_commitment_minor;
  const contactDays = settings.outreach.contact_hours.weekdays
    .map((day) => weekdays[day - 1])
    .join(", ") || "None";
  return (
    <div className={styles.page}>
      <PageHeader description="Review outreach and approval limits for this organization." title="Policies" />
      {policy ? (
        <section className={styles.current} aria-labelledby="current-policy-heading">
          <div className={styles.currentHeader}>
            <div>
              <h2 id="current-policy-heading">Current policy · version {policy.version}</h2>
              <p>Change note: {policy.reason}</p>
            </div>
            {policy.effective_from && <p>Effective {formatDateTime(policy.effective_from, organization.timezone)}</p>}
          </div>
          <dl className={styles.summary}>
            <div><dt>Dispatch</dt><dd>{settings.dispatch_paused ? "Paused" : "Active"}</dd></div>
            <div><dt>Supplier outreach</dt><dd>Email {settings.outreach.email_enabled ? "enabled" : "disabled"} · calls {settings.outreach.call_enabled ? "enabled" : "disabled"}</dd></div>
            <div><dt>Contact hours</dt><dd>{contactDays} · {settings.outreach.contact_hours.start}–{settings.outreach.contact_hours.end}</dd></div>
            <div><dt>Outreach limits</dt><dd>{settings.outreach.max_suppliers_per_episode} {settings.outreach.max_suppliers_per_episode === 1 ? "supplier" : "suppliers"} · {settings.outreach.max_calls_per_episode} calls · {settings.outreach.max_calls_per_supplier_per_episode} calls per supplier · {settings.outreach.max_emails_per_supplier_per_episode} emails per supplier</dd></div>
            <div><dt>Negotiation ceiling</dt><dd>{formatMoney(settings.negotiation.ceiling_minor, organization.currency) ?? "Not set"}</dd></div>
            <div><dt>Approval validity</dt><dd>{minutes(settings.approval.validity_seconds)}</dd></div>
            <div><dt>Freshness</dt><dd>Business data {minutes(settings.freshness.live_business_data_seconds)} · availability {minutes(settings.freshness.availability_recheck_seconds)}</dd></div>
            <div><dt>Budgets</dt><dd>Up to {settings.budgets.max_active_case_steps} recovery steps at once · {settings.budgets.max_inflight_calls_per_org} call{settings.budgets.max_inflight_calls_per_org === 1 ? "" : "s"} at a time</dd></div>
            <div><dt>Commitment authority</dt><dd>{autonomousCommitmentMinor === "0" ? "Owner approves every commitment" : `Conduit may commit up to ${formatMoney(autonomousCommitmentMinor, organization.currency) ?? "the configured limit"} without asking`}</dd></div>
          </dl>
        </section>
      ) : <EmptyState className={styles.empty} icon="shield" message="No current policy is configured." />}
      {membership.role === "owner"
        ? <PolicyEditor currency={organization.currency} initialSettings={settings} version={policy?.version ?? 0} />
        : <p className={styles.readOnly}>Only an owner can edit organization policies. This page is read-only for your role.</p>}
    </div>
  );
}
