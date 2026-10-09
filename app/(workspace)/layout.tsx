import { redirect } from "next/navigation";
import { WorkspaceShell } from "@/components/WorkspaceShell";
import { AuthenticationError, requireMembership } from "@/lib/auth";
import { getOrganization, getSignedInEmail } from "@/lib/db/queries/organization";
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
  const [organization, email] = await Promise.all([
    getOrganization(membership),
    getSignedInEmail(membership),
  ]);

  return (
    <WorkspaceShell
      membership={membership}
      organization={organization}
      email={email}
      environment={APP_ENV}
    >
      {children}
    </WorkspaceShell>
  );
}
