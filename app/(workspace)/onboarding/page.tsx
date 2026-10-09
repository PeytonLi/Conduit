import { requireMembership } from "@/lib/auth";
import { getBusinessData } from "@/lib/db/queries/business-data";
import { listConnections } from "@/lib/db/queries/connections";
import { listCases } from "@/lib/db/queries/cases";
import { caseListQuerySchema } from "@/lib/db/queries/contracts";
import { getCurrentPolicy } from "@/lib/db/queries/policies";
import { listSuppliers } from "@/lib/db/queries/suppliers";

export default async function OnboardingPage() {
  const membership = await requireMembership();
  const [business, connections, suppliers, policy, cases] = await Promise.all([
    getBusinessData(membership),
    listConnections(membership),
    listSuppliers(membership),
    getCurrentPolicy(membership),
    listCases(membership, caseListQuerySchema.parse({ limit: 1 }), new Date()),
  ]);
  const steps = [
    ["Connect a data source", connections.connections.some((entry) => entry.status === "connected") || Object.values(connections.environment_capabilities).some((entry) => entry.ready)],
    ["Load business data", business.datasets.length > 0],
    ["Verify supplier contacts", suppliers.some((supplier) => supplier.contacts.some((contact) => contact.identity_verified))],
    ["Review the current policy", policy !== null],
    ["Review your first case", cases.items.length > 0],
  ] as const;
  return (
    <main>
      <h1>Get started</h1>
      <p>This checklist reflects the data currently available to this organization.</p>
      <ol>{steps.map(([label, complete]) => <li key={label}><strong>{complete ? "Complete" : "Not complete"}</strong> — {label}</li>)}</ol>
    </main>
  );
}
