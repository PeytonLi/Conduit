import { redirect } from "next/navigation";
import { WorkspaceShell } from "@/components/WorkspaceShell";
import { AuthenticationError, requireMembership } from "@/lib/auth";
import { getBusinessData } from "@/lib/db/queries/business-data";
import { listConnections } from "@/lib/db/queries/connections";
import { listCases } from "@/lib/db/queries/cases";
import { caseListQuerySchema } from "@/lib/db/queries/contracts";
import { getOrganization, getSignedInEmail } from "@/lib/db/queries/organization";
import { getCurrentPolicy } from "@/lib/db/queries/policies";
import { listSuppliers } from "@/lib/db/queries/suppliers";
import { systemClock } from "@/lib/db/queries/clock";
import { parseServerEnv } from "@/lib/env";

export default async function WorkspaceLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  let membership;
  try {
    membership = await requireMembership();
  } catch (error) {
    if (error instanceof AuthenticationError) {
      redirect("/login");
    }
    throw error;
  }
  const { APP_ENV } = parseServerEnv(process.env);
  const [organization, email, business, connections, suppliers, policy, cases] = await Promise.all([
    getOrganization(membership),
    getSignedInEmail(membership),
    getBusinessData(membership),
    listConnections(membership),
    listSuppliers(membership),
    getCurrentPolicy(membership),
    listCases(membership, caseListQuerySchema.parse({ limit: 1 }), systemClock.now()),
  ]);
  const onboardingComplete = (
    connections.connections.some((entry) => entry.status === "connected") ||
    Object.values(connections.environment_capabilities).some((entry) => entry.ready)
  ) && business.datasets.length > 0 &&
    suppliers.some((supplier) => supplier.contacts.some((contact) => contact.identity_verified)) &&
    policy !== null && cases.items.length > 0;

  return (
    <WorkspaceShell
      membership={membership}
      organization={organization}
      email={email}
      environment={APP_ENV}
      onboardingComplete={onboardingComplete}
    >
      {children}
    </WorkspaceShell>
  );
}
