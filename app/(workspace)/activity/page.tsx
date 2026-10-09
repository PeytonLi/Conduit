import Link from "next/link";
import { requireMembership } from "@/lib/auth";
import { listActivity } from "@/lib/db/queries/activity";
import { formatDateTime } from "@/lib/db/queries/format";

type Search = Record<string, string | string[] | undefined>;

export default async function ActivityPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const value = (key: string) => typeof params[key] === "string" ? params[key] as string : undefined;
  const membership = await requireMembership();
  const page = await listActivity(membership, {
    case_id: value("case_id"),
    actor: value("actor"),
    outcome: value("outcome"),
    limit: 25,
    cursor: value("cursor"),
  });
  return (
    <main>
      <h1>Activity</h1>
      <form method="get">
        <label>Case ID <input name="case_id" defaultValue={value("case_id")} /></label>
        <label>Actor ID <input name="actor" defaultValue={value("actor")} /></label>
        <label>Event <input name="outcome" defaultValue={value("outcome")} /></label>
        <button type="submit">Filter activity</button>
        <Link href="/activity">Clear</Link>
      </form>
      {page.items.length ? <table>
        <caption>Organization activity</caption>
        <thead><tr><th scope="col">Time</th><th scope="col">Event</th><th scope="col">Actor</th><th scope="col">Outcome</th><th scope="col">Reason</th><th scope="col">Case</th></tr></thead>
        <tbody>{page.items.map((entry) => <tr key={entry.id}>
          <td>{formatDateTime(entry.at, "UTC") ?? "Unknown"}</td><td>{entry.event_name}</td><td>{entry.actor.label}</td><td>{entry.outcome ?? "Unknown"}</td><td>{entry.reason ?? "Unknown"}</td><td>{entry.case_id ? <Link href={`/cases/${entry.case_id}`}>Open case</Link> : "—"}</td>
        </tr>)}</tbody>
      </table> : <p>No activity matches these filters.</p>}
      {page.next_cursor && <Link href={`/activity?${new URLSearchParams({ ...(value("case_id") ? { case_id: value("case_id")! } : {}), ...(value("actor") ? { actor: value("actor")! } : {}), ...(value("outcome") ? { outcome: value("outcome")! } : {}), cursor: page.next_cursor })}`}>Next page</Link>}
    </main>
  );
}
