import { requireMembership } from "@/lib/auth";
import { listMemberships } from "@/lib/db/queries/memberships";
import { MembershipControls } from "@/components/MembershipControls";
import { DataTable } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import styles from "./members.module.css";

export default async function MembersSettingsPage() {
  const membership = await requireMembership();
  const members = await listMemberships(membership);
  return (
    <main className={styles.page}>
      <PageHeader description="Manage organization roles and access." title="Members" />
      {members.length ? <DataTable caption="Organization members" className={styles.table}>
        <thead><tr><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Active</th></tr></thead>
        <tbody>{members.map((member) => <tr key={member.id}>
          <td>{member.email ?? "Unknown"}{member.is_self ? " (you)" : ""}</td>
          <MembershipControls editable={membership.role === "owner"} member={member} />
        </tr>)}</tbody>
      </DataTable> : <EmptyState message="No organization members are available." />}
    </main>
  );
}
