import { requireMembership } from "@/lib/auth";
import { listConnections } from "@/lib/db/queries/connections";
import { formatDateTime } from "@/lib/db/queries/format";
import { humanLabel } from "@/lib/db/queries/labels";
import { parseServerEnv } from "@/lib/env";
import { Card } from "@/components/ui/Card";
import { Disclosure } from "@/components/ui/Disclosure";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusBadge } from "@/components/StatusBadge";
import styles from "./integrations.module.css";

const purposeByCapability: Record<string, string> = {
  deepseek: "Reads supplier emails and drafts recovery plans.",
  gmail: "Receives supplier delay emails and sends approved replies.",
  voice: "Calls approved supplier contacts for quotes.",
  exa: "Finds alternative suppliers.",
  neatlogs: "Records traces for troubleshooting.",
  inngest: "Runs case workflows in the background.",
};

export default async function IntegrationsSettingsPage() {
  const membership = await requireMembership();
  const appEnvironment = parseServerEnv(process.env).APP_ENV;
  const result = await listConnections(membership);
  const configured = new Map(result.connections.map((connection) => [connection.provider, connection]));
  const providers = [...new Set([
    ...result.connections.map((connection) => connection.provider),
    ...Object.keys(result.environment_capabilities),
  ])];
  const readinessByProvider = result.environment_capabilities as Record<string, {
    ready: boolean;
    missing: string[];
  }>;
  return (
    <main className={styles.page}>
      <PageHeader description="Check provider readiness and setup needs." title="Integrations" />
      {providers.length ? (
        <section aria-label="Provider status" className={styles.grid}>
          {providers.map((provider) => {
            const connection = configured.get(provider);
            const readiness = readinessByProvider[provider];
            const ready = readiness
              ? readiness.ready && (!connection || connection.status === "connected")
              : connection?.status === "connected";
            const notNeededInReplay = appEnvironment === "replay";
            return (
              <Card className={styles.card} key={provider}>
                <div className={styles.cardHeading}>
                  <h2>{connection ? humanLabel("provider", provider) : humanLabel("capability", provider)}</h2>
                  <StatusBadge tone={notNeededInReplay ? "neutral" : ready ? "success" : "warning"}>
                    {notNeededInReplay ? "Not needed in replay" : ready ? "Ready" : "Needs setup"}
                  </StatusBadge>
                </div>
                <p>{purposeByCapability[provider] ?? "Connect this provider to Conduit."}</p>
                {connection && (
                  <>
                    <p>Last successful sync: {formatDateTime(connection.last_success_at, "UTC") ?? "No successful sync yet"}</p>
                    {connection.last_error_message && <p className={styles.error}>{connection.last_error_message}</p>}
                    <ul className={styles.capabilities}>
                      {Object.entries(connection.capabilities).map(([name, available]) => (
                        <li key={name}>{humanLabel("capability", name)}: {available ? "Ready" : "Unavailable"}</li>
                      ))}
                    </ul>
                  </>
                )}
                <Disclosure summary="Setup details">
                  {membership.role === "owner" && readiness?.missing.length ? (
                    <ul>{readiness.missing.map((name) => <li key={name}>{name}</li>)}</ul>
                  ) : !ready ? (
                    <p>Ask an owner to review this provider’s environment configuration.</p>
                  ) : (
                    <p>No missing environment configuration was reported.</p>
                  )}
                </Disclosure>
              </Card>
            );
          })}
        </section>
      ) : <p>No provider connections are configured.</p>}
    </main>
  );
}
