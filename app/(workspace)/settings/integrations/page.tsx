import { requireMembership } from "@/lib/auth";
import { listConnections } from "@/lib/db/queries/connections";
import { formatDateTime } from "@/lib/db/queries/format";
import { humanLabel } from "@/lib/db/queries/labels";

export default async function IntegrationsSettingsPage() {
  const membership = await requireMembership();
  const result = await listConnections(membership);
  const configured = new Map(result.connections.map((connection) => [connection.provider, connection]));
  return (
    <main>
      <h1>Integrations</h1>
      <p>Readiness reflects available capabilities; credentials are never shown here.</p>
      <section><h2>Providers</h2>
        {result.connections.length ? result.connections.map((connection) => (
          <article key={connection.provider}>
            <h3>{humanLabel("provider", connection.provider)}</h3><p>Status: {humanLabel("connectionStatus", connection.status)}</p>
            <p>Last successful sync: {formatDateTime(connection.last_success_at, "UTC") ?? "Unknown"}</p>
            {connection.last_error_message && <p>{connection.last_error_message}</p>}
            <ul>{Object.entries(connection.capabilities).map(([name, ready]) => <li key={name}>{humanLabel("capability", name)}: {ready ? "Ready" : "Unavailable"}</li>)}</ul>
          </article>
        )) : <p>No provider connections are configured.</p>}
      </section>
      <section><h2>Environment capabilities</h2><ul>
        {Object.entries(result.environment_capabilities).map(([name, readiness]) => (
          <li key={name}>{humanLabel("capability", name)}: {readiness.ready ? "Ready" : "Not ready"}
            {membership.role === "owner" && readiness.missing.length > 0 ? ` · Missing configuration: ${readiness.missing.join(", ")}` : ""}
            {!configured.has(name) && !readiness.ready ? " · No connection is configured." : ""}
          </li>
        ))}
      </ul></section>
    </main>
  );
}
