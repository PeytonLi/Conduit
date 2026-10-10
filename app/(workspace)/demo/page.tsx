import { DemoRun } from "@/components/DemoRun";
import { requireMembership } from "@/lib/auth";
import { getOrganization } from "@/lib/db/queries/organization";
import { PageHeader } from "@/components/ui/PageHeader";
import styles from "./demo.module.css";

export default async function DemoPage() {
  const membership = await requireMembership();
  const organization = await getOrganization(membership);
  const disabled = organization.environment_mode === "live" || membership.role !== "owner";
  return (
    <main className={styles.page}>
      <PageHeader description="Load a simulated supplier-delay scenario for this workspace." title="Demo scenarios" />
      {organization.environment_mode === "live" && <p role="alert">Demo runs are disabled for live organizations.</p>}
      {membership.role !== "owner" && <p>Only an owner can load a demo scenario.</p>}
      <DemoRun disabled={disabled} />
    </main>
  );
}
