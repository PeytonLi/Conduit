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
import { ConnectGmailButton } from "@/components/ConnectGmailButton";

type IntegrationsSearchParams = {
  gmail?: string | string[];
  code?: string | string[];
};

const gmailErrorReasons: Record<string, string> = {
  gmail_not_configured: "The Gmail integration is not configured.",
  connection_failed: "The authorization was not completed.",
  connection_verification_failed: "The connected account could not be verified.",
  missing_code: "Google did not return an authorization code.",
  exchange_failed: "Google could not complete the authorization.",
  unauthorized: "Sign in as an organization owner to connect Gmail.",
  bad_signature: "The authorization request could not be verified.",
  expired: "The connection request expired. Start again.",
  nonce_mismatch: "The connection request could not be verified. Start again.",
  user_mismatch: "Sign in with the account that started the connection.",
  org_mismatch: "The request belongs to a different organization.",
  not_owner: "Only an organization owner can connect Gmail.",
  redirect_mismatch: "The callback URL did not match the connection request.",
  malformed: "The authorization request was invalid.",
};

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

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

export default async function IntegrationsSettingsPage({
  searchParams,
}: {
  searchParams: Promise<IntegrationsSearchParams>;
}) {
  const query = await searchParams;
  const gmailStatus = firstParam(query.gmail);
  const gmailError = firstParam(query.code);
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
      {gmailStatus === "connected" && (
        <p className={`${styles.notice} ${styles.noticeSuccess}`} role="status">
          Gmail connected. Conduit will start reading supplier emails within a few minutes.
        </p>
      )}
      {gmailStatus === "error" && (
        <p className={`${styles.notice} ${styles.noticeError}`} role="alert">
          Gmail couldn’t be connected. {gmailErrorReasons[gmailError] ?? "Please try again or ask an owner to review the setup."}
        </p>
      )}
      {providers.length ? (
        <section aria-label="Provider status" className={styles.grid}>
          {providers.map((provider) => {
            const connection = configured.get(provider);
            const readiness = readinessByProvider[provider];
            const connected = Boolean(connection && ["healthy", "degraded"].includes(connection.status));
            const ready = readiness
              ? readiness.ready && (provider === "gmail" ? connected : (!connection || connected))
              : connected;
            const notNeededInReplay = appEnvironment === "replay";
            const notConnectedGmail = provider === "gmail" && !connected;
            const statusLabel = notNeededInReplay
              ? "Not needed in replay"
              : notConnectedGmail
                ? "Not connected"
                : ready
                  ? "Ready"
                  : "Needs setup";
            const statusTone = notNeededInReplay
              ? "neutral"
              : notConnectedGmail
                ? "warning"
                : ready
                  ? "success"
                  : "warning";
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
                  <StatusBadge tone={statusTone}>
                    {statusLabel}
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
                  {provider === "gmail" &&
                    connected &&
                    membership.role === "owner" && (
                    <DisconnectGmailButton />
                  )}
                  {provider === "gmail" &&
                    !connected &&
                    !notNeededInReplay &&
                    readiness?.ready &&
                    membership.role === "owner" && (
                      <ConnectGmailButton />
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
