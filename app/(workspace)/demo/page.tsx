import { DemoLiveCall } from "@/components/DemoLiveCall";
import { DemoRun } from "@/components/DemoRun";
import { requireMembership } from "@/lib/auth";
import { getOrganization } from "@/lib/db/queries/organization";
import { PageHeader } from "@/components/ui/PageHeader";
import styles from "./demo.module.css";

export default async function DemoPage() {
  const membership = await requireMembership();
  const organization = await getOrganization(membership);
  const isOwner = membership.role === "owner";
  const replayDisabled = organization.environment_mode === "live" || !isOwner;
  const liveCallDisabled = organization.environment_mode !== "sandbox" || !isOwner;
  return (
    <div className={styles.page}>
      <PageHeader
        description="Load a Harbor Pack replay, or place a real sandbox phone call for recording."
        title="Demo scenarios"
      />
      {organization.environment_mode === "live" && <p role="alert">Demo runs are disabled for live organizations.</p>}
      {!isOwner && <p>Only an owner can run demo scenarios or place a live demo call.</p>}
      <DemoRun disabled={replayDisabled} />
      {organization.environment_mode === "sandbox" ? (
        <DemoLiveCall disabled={liveCallDisabled} />
      ) : (
        <p>Live demo calls are available when this organization is in sandbox mode.</p>
      )}
    </div>
  );
}
