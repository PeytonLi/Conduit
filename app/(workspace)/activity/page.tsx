import Link from "next/link";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { DataTable } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { SelectField } from "@/components/ui/Field";
import { PageHeader } from "@/components/ui/PageHeader";
import { requireMembership } from "@/lib/auth";
import { listActivity } from "@/lib/db/queries/activity";
import { formatDateTime } from "@/lib/db/queries/format";
import { getOrganization } from "@/lib/db/queries/organization";
import { labels } from "@/lib/ui/labels";
import styles from "./activity.module.css";

type Search = Record<string, string | string[] | undefined>;

export default async function ActivityPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const value = (key: string) => typeof params[key] === "string" ? params[key] as string : undefined;
  const caseFilter = value("case") ?? value("case_id");
  const eventFilter = value("event") ?? value("outcome");
  const membership = await requireMembership();
  const [page, organization] = await Promise.all([
    listActivity(membership, {
      case_id: caseFilter,
      actor: value("actor"),
      outcome: eventFilter,
      limit: 25,
      cursor: value("cursor"),
    }),
    getOrganization(membership),
  ]);
  const clearCaseParams = new URLSearchParams();
  if (value("actor")) clearCaseParams.set("actor", value("actor")!);
  if (eventFilter) clearCaseParams.set("event", eventFilter);
  const clearCaseHref = `/activity${clearCaseParams.toString() ? `?${clearCaseParams}` : ""}`;
  const nextPageParams = new URLSearchParams();
  if (caseFilter) nextPageParams.set("case", caseFilter);
  if (value("actor")) nextPageParams.set("actor", value("actor")!);
  if (eventFilter) nextPageParams.set("event", eventFilter);
  if (page.next_cursor) nextPageParams.set("cursor", page.next_cursor);
  return (
    <main className={styles.page}>
      <PageHeader title="Activity" description="A clear record of changes across your organization." />
      <Card>
        <form className={styles.filters} method="get">
          {caseFilter && <input name="case" type="hidden" value={caseFilter} />}
          {value("actor") && <input name="actor" type="hidden" value={value("actor")} />}
          <SelectField defaultValue={eventFilter ?? ""} label="Event" name="event">
            <option value="">All events</option>
            {Object.entries(labels.auditEvent).sort(([, a], [, b]) => a.localeCompare(b)).map(([event, label]) => (
              <option key={event} value={event}>{label}</option>
            ))}
          </SelectField>
          <div className={styles.filterActions}>
            <Button type="submit">Filter activity</Button>
            <ButtonLink href="/activity" variant="ghost">Clear</ButtonLink>
          </div>
        </form>
      </Card>
      {caseFilter && (
        <p className={styles.filterChip} role="status">
          Filtered to one case <Link href={clearCaseHref}>Clear case filter</Link>
        </p>
      )}
      {page.items.length ? (
        <DataTable caption="Organization activity">
          <thead><tr><th scope="col">Time</th><th scope="col">Event</th><th scope="col">Actor</th><th scope="col">Reason</th><th scope="col">Case</th></tr></thead>
          <tbody>{page.items.map((entry) => <tr key={entry.id}>
            <td>{formatDateTime(entry.at, organization.timezone) ?? "Unknown"}</td>
            <td>{entry.event_name}</td>
            <td>{entry.actor.label}</td>
            <td>{entry.reason ?? "—"}</td>
            <td>{entry.case_id ? <Link href={`/cases/${entry.case_id}`}>Open case</Link> : "—"}</td>
          </tr>)}</tbody>
        </DataTable>
      ) : <EmptyState message="No activity matches these filters." />}
      {page.next_cursor && (
        <div className={styles.nextPage}>
          <ButtonLink href={`/activity?${nextPageParams}`} variant="secondary">
            Next page
          </ButtonLink>
        </div>
      )}
    </main>
  );
}
