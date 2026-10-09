import { redirect } from "next/navigation";
import { WorkspaceShell } from "@/components/WorkspaceShell";
import { AuthenticationError, requireMembership } from "@/lib/auth";
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

  return (
    <WorkspaceShell membership={membership} environment={APP_ENV}>
      {children}
    </WorkspaceShell>
  );
}
