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
import { ConnectGmailButton } from "@/components/ConnectGmailButton";
import { ConnectOutlookButton } from "@/components/MailboxControls";
import { isActiveMailboxStatus, isMailboxProvider } from "@/lib/integrations/mailbox/types";
import { MailboxList } from "./MailboxList";
import { ConnectBusinessSystem, ConnectedBusinessSystemActions } from "@/components/BusinessSystemControls";
import { availableBusinessSystems, type BusinessConnectMethod } from "@/lib/integrations/business/live/availability";
import { erpProviderLabels, isErpProvider } from "@/lib/integrations/business/live/registry";

type IntegrationsSearchParams = {
  gmail?: string | string[];
  outlook?: string | string[];
  business?: string | string[];
  provider?: string | string[];
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

const outlookErrorReasons: Record<string, string> = {
  outlook_not_configured: "The Outlook integration is not configured.",
  outlook_unavailable_in_replay: "Outlook is not used in replay mode.",
  access_denied: "Microsoft access was not granted.",
  connection_failed: "The authorization was not completed.",
  connection_verification_failed: "The connected account could not be verified.",
  missing_code: "Microsoft did not return an authorization code.",
  exchange_failed: "Microsoft could not complete the authorization. Make sure mail read and send access were allowed.",
  unauthorized: "Sign in as an organization owner to connect Outlook.",
  bad_signature: "The authorization request could not be verified.",
  expired: "The connection request expired. Start again.",
  nonce_mismatch: "The connection request could not be verified. Start again.",
  user_mismatch: "Sign in with the account that started the connection.",
  org_mismatch: "The request belongs to a different organization.",
  not_owner: "Only an organization owner can connect Outlook.",
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
  outlook: "Receives supplier delay emails and sends approved replies from Outlook.",
  voice: "Calls approved supplier contacts for quotes.",
  exa: "Finds alternative suppliers.",
  inngest: "Runs case workflows in the background.",
};

const iconByCapability = {
  deepseek: "sparkle",
  gmail: "inbox",
  outlook: "inbox",
  voice: "phone",
  exa: "search",
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
  const outlookStatus = firstParam(query.outlook);
  const membership = await requireMembership();
  const appEnvironment = parseServerEnv(process.env).APP_ENV;
  const [result, organization] = await Promise.all([
    listConnections(membership),
    getOrganization(membership),
  ]);
  // One entry per provider. With several connections of a provider (two
  // mailboxes), an active one is preferred so the card reflects whether the
  // provider is usable at all; per-connection detail is in the Mailboxes list.
  const configured = new Map<string, (typeof result.connections)[number]>();
  for (const connection of result.connections) {
    const current = configured.get(connection.provider);
    if (!current || (!isActiveMailboxStatus(current.status) && isActiveMailboxStatus(connection.status))) {
      configured.set(connection.provider, connection);
    }
  }
  const mailboxes = result.connections.filter(
    (connection) => isMailboxProvider(connection.provider) && connection.status !== "disconnected",
  );
  const now = new Date();
  const businessStatus = firstParam(query.business);
  const businessProvider = firstParam(query.provider);
  const businessLabel = isErpProvider(businessProvider) ? erpProviderLabels[businessProvider] : "The business system";
  const businessSystems = availableBusinessSystems(process.env);
  const businessConnection = result.connections.find(
    (connection) => isErpProvider(connection.provider) && ["healthy", "degraded"].includes(connection.status),
  );
  // A connected provider stays visible even if its app credentials were later removed.
  const businessCards: { provider: string; label: string; method: BusinessConnectMethod; connectPath: string }[] = [
    ...(businessConnection && !businessSystems.some((system) => system.provider === businessConnection.provider)
      ? [{ provider: businessConnection.provider, label: humanLabel("provider", businessConnection.provider), method: "oauth" as const, connectPath: "" }]
      : []),
    ...businessSystems,
  ];
  const providers = [...new Set([
    ...result.connections.map((connection) => connection.provider).filter((provider) => !isErpProvider(provider)),
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
      {outlookStatus === "connected" && (
        <p className={`${styles.notice} ${styles.noticeSuccess}`} role="status">
          Outlook connected. Conduit will start reading supplier emails within a few minutes.
        </p>
      )}
      {outlookStatus === "error" && (
        <p className={`${styles.notice} ${styles.noticeError}`} role="alert">
          Outlook couldn’t be connected. {outlookErrorReasons[gmailError] ?? "Please try again or ask an owner to review the setup."}
        </p>
      )}
      {mailboxes.length > 0 && (
        <MailboxList
          canManage={membership.role === "owner"}
          formatLastSynced={(value) => formatLastSynced(value, organization.timezone)}
          mailboxes={mailboxes}
          now={now}
          providerLabel={(provider) => humanLabel("provider", provider)}
        />
      )}
      {businessStatus === "connected" && (
        <p className={`${styles.notice} ${styles.noticeSuccess}`} role="status">
          {businessLabel} connected. Conduit is importing purchase orders and stock now.
        </p>
      )}
      {businessStatus === "error" && (
        <p className={`${styles.notice} ${styles.noticeError}`} role="alert">
          {businessLabel} couldn’t be connected. {firstParam(query.code) ? `(${firstParam(query.code)}) ` : ""}Please try again.
        </p>
      )}
      <section aria-labelledby="business-system-heading" className={styles.businessSection}>
        <h2 className={styles.sectionHeading} id="business-system-heading">Business system</h2>
        <p className={styles.purpose}>
          Conduit reads purchase orders, stock and receipts from one business system and writes approved delivery changes back.
        </p>
        {appEnvironment === "replay" ? (
          <p className={styles.purpose}>Not needed in replay. Replay uses the demo ledger.</p>
        ) : businessSystems.length === 0 && !businessConnection ? (
          <EmptyState icon="plug" message="No business system is configured for this deployment." />
        ) : (
          <div className={styles.grid}>
            {businessCards.map((system) => {
              const connected = businessConnection?.provider === system.provider ? businessConnection : null;
              const label = isErpProvider(system.provider) ? erpProviderLabels[system.provider] : system.label;
              return (
                <Card className={styles.card} key={system.provider}>
                  <div className={styles.cardHeading}>
                    <div className={styles.cardIdentity}>
                      <span aria-hidden="true" className={styles.iconTile}>
                        <Icon name="plug" />
                      </span>
                      <h3>{label}</h3>
                    </div>
                  </div>
                  <div className={styles.cardStatus}>
                    <StatusBadge tone={connected ? (connected.status === "healthy" ? "success" : "warning") : "neutral"}>
                      {connected ? (connected.status === "healthy" ? "Connected" : "Connected, needs attention") : "Not connected"}
                    </StatusBadge>
                  </div>
                  <div className={styles.connectionDetails}>
                    {connected && (
                      <>
                        <p className={styles.syncLine}>
                          Last synced {formatLastSynced(connected.last_success_at, organization.timezone)}
                        </p>
                        {connected.last_error_message && <p className={styles.error}>{connected.last_error_message}</p>}
                      </>
                    )}
                  </div>
                  {membership.role === "owner" && (
                    <div className={styles.cardFooter}>
                      {connected ? (
                        <ConnectedBusinessSystemActions label={label} provider={system.provider} />
                      ) : businessConnection ? (
                        <p className={styles.purpose}>Disconnect {humanLabel("provider", businessConnection.provider)} to use {label}.</p>
                      ) : (
                        <ConnectBusinessSystem connectPath={system.connectPath} label={label} method={system.method} />
                      )}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </section>
      {providers.length ? (
        <section aria-label="Provider status" className={styles.grid}>
          {providers.map((provider) => {
            const connection = configured.get(provider);
            const readiness = readinessByProvider[provider];
            const connected = Boolean(connection && ["healthy", "degraded"].includes(connection.status));
            const isMailbox = isMailboxProvider(provider);
            const ready = readiness
              ? readiness.ready && (isMailbox ? connected : (!connection || connected))
              : connected;
            const notNeededInReplay = appEnvironment === "replay";
            const notConnectedMailbox = isMailbox && !connected;
            const statusLabel = notNeededInReplay
              ? "Not needed in replay"
              : notConnectedMailbox
                ? "Not connected"
                : ready
                  ? "Ready"
                  : "Needs setup";
            const statusTone = notNeededInReplay
              ? "neutral"
              : notConnectedMailbox
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
                          const isRead = isMailbox && normalizedName.includes("read");
                          const isSend = isMailbox && normalizedName.includes("send");
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
                  {/* Disconnect lives per connection in the Mailboxes list. A
                      mailbox can always be added: that is how a second one joins. */}
                  {provider === "gmail" &&
                    !notNeededInReplay &&
                    readiness?.ready &&
                    membership.role === "owner" && (
                      <ConnectGmailButton another={connected} />
                    )}
                  {provider === "outlook" &&
                    !notNeededInReplay &&
                    readiness?.ready &&
                    membership.role === "owner" && (
                      <ConnectOutlookButton another={connected} />
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
