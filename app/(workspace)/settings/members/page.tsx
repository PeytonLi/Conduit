import { requireMembership } from "@/lib/auth";
import { listMemberships } from "@/lib/db/queries/memberships";
import { MembershipControls } from "@/components/MembershipControls";

export default async function MembersSettingsPage() {
  const membership = await requireMembership();
  const members = await listMemberships(membership);
  return (
    <main>
      <h1>Members</h1>
      {members.length ? <table>
        <caption>Organization members</caption>
        <thead><tr><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead>
        <tbody>{members.map((member) => <tr key={member.id}>
          <td>{member.email ?? "Unknown"}{member.is_self ? " (you)" : ""}</td><td>{member.role}</td><td>{member.active ? "Active" : "Inactive"}</td>
          <td>{membership.role === "owner" ? <MembershipControls member={member} /> : "Read-only"}</td>
        </tr>)}</tbody>
      </table> : <p>No organization members are available.</p>}
    </main>
  );
}
