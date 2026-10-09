import { requireMembership } from "@/lib/auth";
import { humanLabel } from "@/lib/db/queries/labels";
import { getCurrentPolicy } from "@/lib/db/queries/policies";
import { formatDateTime } from "@/lib/db/queries/format";

export default async function PoliciesSettingsPage() {
  const membership = await requireMembership();
  const policy = await getCurrentPolicy(membership);
  return (
    <main>
      <h1>Policies</h1>
      {policy ? <>
        <h2>Policy version {policy.version}</h2>
        <p>Effective {formatDateTime(policy.effective_from, "UTC") ?? "Unknown"}</p>
        <p>{policy.reason}</p>
        <dl>{Object.entries(policy.settings).map(([key, value]) => <div key={key}><dt>{humanLabel("policySetting", key)}</dt><dd>{typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value)}</dd></div>)}</dl>
      </> : <p>No current policy is configured.</p>}
      {membership.role === "owner"
        ? <p role="status">Policy editing is unavailable in this build; the current version remains unchanged.</p>
        : <p>Only an owner can edit organization policies. This page is read-only for your role.</p>}
    </main>
  );
}
