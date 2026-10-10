import { requireMembership } from "@/lib/auth";
import { getCurrentPolicy } from "@/lib/db/queries/policies";
import { formatDateTime, formatMoney } from "@/lib/db/queries/format";
import { getOrganization } from "@/lib/db/queries/organization";
import { policySettingsSchema } from "@/lib/policies/schema";
import { PolicyEditor } from "@/components/PolicyEditor";
import styles from "./policies.module.css";

const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export default async function PoliciesSettingsPage() {
  const membership = await requireMembership();
  const [policy, organization] = await Promise.all([
    getCurrentPolicy(membership),
    getOrganization(membership),
  ]);
  const settings = policySettingsSchema.parse(policy?.settings ?? {});
  const contactDays = settings.outreach.contact_hours.weekdays
    .map((day) => weekdays[day - 1])
    .join(", ") || "None";
  return (
    <main className={styles.page}>
      <h1>Policies</h1>
      {policy ? (
        <section className={styles.current} aria-labelledby="current-policy-heading">
          <div className={styles.currentHeader}>
            <div>
              <h2 id="current-policy-heading">Current policy · version {policy.version}</h2>
              <p>{policy.reason}</p>
            </div>
            <p>Effective {formatDateTime(policy.effective_from, organization.timezone) ?? "Unknown"}</p>
          </div>
          <dl className={styles.summary}>
            <div><dt>Dispatch</dt><dd>{settings.dispatch_paused ? "Paused" : "Active"}</dd></div>
            <div><dt>Supplier outreach</dt><dd>Email {settings.outreach.email_enabled ? "enabled" : "disabled"} · calls {settings.outreach.call_enabled ? "enabled" : "disabled"}</dd></div>
            <div><dt>Contact hours</dt><dd>{contactDays} · {settings.outreach.contact_hours.start}–{settings.outreach.contact_hours.end}</dd></div>
            <div><dt>Outreach limits</dt><dd>{settings.outreach.max_suppliers_per_episode} suppliers · {settings.outreach.max_calls_per_episode} calls · {settings.outreach.max_calls_per_supplier_per_episode} calls per supplier · {settings.outreach.max_emails_per_supplier_per_episode} emails per supplier</dd></div>
            <div><dt>Negotiation ceiling</dt><dd>{formatMoney(settings.negotiation.ceiling_minor, organization.currency) ?? "Not set"}</dd></div>
            <div><dt>Approval validity</dt><dd>{settings.approval.validity_seconds} seconds</dd></div>
            <div><dt>Freshness</dt><dd>Business data {settings.freshness.live_business_data_seconds}s · availability {settings.freshness.availability_recheck_seconds}s</dd></div>
            <div><dt>Budgets</dt><dd>{settings.budgets.max_active_case_steps} active steps · {settings.budgets.max_inflight_calls_per_org} in-flight calls per organization</dd></div>
            <div><dt>Commitment authority</dt><dd>Owner · autonomous commitment {formatMoney("0", organization.currency)}</dd></div>
          </dl>
        </section>
      ) : <p className={styles.empty}>No current policy is configured.</p>}
      {membership.role === "owner"
        ? <PolicyEditor currency={organization.currency} initialSettings={settings} version={policy?.version ?? 0} />
        : <p className={styles.readOnly}>Only an owner can edit organization policies. This page is read-only for your role.</p>}
    </main>
  );
}
