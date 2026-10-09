import { DemoRun } from "@/components/DemoRun";
import { requireMembership } from "@/lib/auth";
import { getOrganization } from "@/lib/db/queries/organization";

export default async function DemoPage() {
  const membership = await requireMembership();
  const organization = await getOrganization(membership);
  const disabled = organization.environment_mode === "live" || membership.role !== "owner";
  return (
    <main>
      <h1>Demo scenarios</h1>
      <p>Choose a fixture and optionally reset existing demo data before loading it.</p>
      {organization.environment_mode === "live" && <p role="alert">Demo runs are disabled for live organizations.</p>}
      {membership.role !== "owner" && <p>Only an owner can load a demo scenario.</p>}
      <DemoRun disabled={disabled} />
    </main>
  );
}
