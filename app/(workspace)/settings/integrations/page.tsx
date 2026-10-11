import { requireMembership } from "@/lib/auth";
import { listConnections } from "@/lib/db/queries/connections";
import { getOrganization } from "@/lib/db/queries/organization";
import { humanLabel } from "@/lib/db/queries/labels";
import { parseServerEnv } from "@/lib/env";
import { Card } from "@/components/ui/Card";
import { Disclosure } from "@/components/ui/Disclosure";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { Icon } from "@/components/ui/Icon";
import { EmptyState } from "@/components/ui/EmptyState";
import styles from "./integrations.module.css";
import { DisconnectGmailButton } from "@/components/DisconnectGmailButton";

function formatLastSynced(value: string | null, timeZone: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(date);
}

const purposeByCapability: Record<string, string> = {
  deepseek: "Reads supplier emails and drafts recovery plans.",
  gmail: "Receives supplier delay emails and sends approved replies.",
  voice: "Calls approved supplier contacts for quotes.",
  exa: "Finds alternative suppliers.",
  neatlogs: "Records traces for troubleshooting.",
  inngest: "Runs case workflows in the background.",
};

const iconByCapability = {
  deepseek: "sparkle",
  gmail: "inbox",
  voice: "phone",
  exa: "search",
  neatlogs: "activity",
  inngest: "clock",
} as const;

export default async function IntegrationsSettingsPage() {
  const membership = await requireMembership();
  const appEnvironment = parseServerEnv(process.env).APP_ENV;
  const [result, organization] = await Promise.all([
    listConnections(membership),
    getOrganization(membership),
  ]);
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
    <div className={styles.page}>
      <PageHeader description="Check provider readiness and setup needs." title="Integrations" />
      {providers.length ? (
        <section aria-label="Provider status" className={styles.grid}>
          {providers.map((provider) => {
            const connection = configured.get(provider);
            const readiness = readinessByProvider[provider];
            const connected = Boolean(connection && ["healthy", "degraded"].includes(connection.status));
            const ready = readiness
              ? readiness.ready && (!connection || connected)
              : connected;
            const notNeededInReplay = appEnvironment === "replay";
            return (
              <Card className={styles.card} key={provider}>
                <div className={styles.cardHeading}>
                  <div className={styles.cardIdentity}>
                    <span aria-hidden="true" className={styles.iconTile}>
                      <Icon name={iconByCapability[provider as keyof typeof iconByCapability] ?? "plug"} />
                    </span>
                    <h2>{connection ? humanLabel("provider", provider) : humanLabel("capability", provider)}</h2>
                  </div>
                </div>
                <div className={styles.cardStatus}>
                  <StatusBadge tone={notNeededInReplay ? "neutral" : ready ? "success" : "warning"}>
                    {notNeededInReplay ? "Not needed in replay" : ready ? "Ready" : "Needs setup"}
                  </StatusBadge>
                </div>
                <p className={styles.purpose}>{purposeByCapability[provider] ?? "Connect this provider to Conduit."}</p>
                <div className={styles.connectionDetails}>
                  {connection && (
                    <>
                      <p className={styles.syncLine}>
                        Last synced {formatLastSynced(connection.last_success_at, organization.timezone)}
                      </p>
                      {connection.last_error_message && <p className={styles.error}>{connection.last_error_message}</p>}
                      <div className={styles.capabilities}>
                        {Object.entries(connection.capabilities).map(([name, available]) => {
                          const normalizedName = name.toLowerCase();
                          const isRead = provider === "gmail" && normalizedName.includes("read");
                          const isSend = provider === "gmail" && normalizedName.includes("send");
                          const label = isRead
                            ? `Read ${available ? "✓" : "—"}`
                            : isSend
                              ? `Send ${available ? "✓" : "—"}`
                              : `${humanLabel("capability", name)}: ${available ? "Ready" : "Unavailable"}`;
                          return (
                            <StatusBadge key={name} tone={available ? "success" : "warning"}>
                              {label}
                            </StatusBadge>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
                <div className={styles.cardFooter}>
                  <Disclosure className={styles.setupDetails} summary="Setup details">
                    {notNeededInReplay ? (
                      <p>No provider setup is needed for replay.</p>
                    ) : membership.role === "owner" && readiness?.missing.length ? (
                      <ul>{readiness.missing.map((name) => <li key={name}>{name}</li>)}</ul>
                    ) : !ready ? (
                      <p>Ask an owner to review this provider’s environment configuration.</p>
                    ) : (
                      <p>No missing environment configuration was reported.</p>
                    )}
                  </Disclosure>
                  {provider === "gmail" && connected && membership.role === "owner" && (
                    <DisconnectGmailButton />
                  )}
                </div>
              </Card>
            );
          })}
        </section>
      ) : <EmptyState icon="plug" message="No provider connections are configured." />}
    </div>
  );
}
