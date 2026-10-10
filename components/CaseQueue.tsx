"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CaseListQuery } from "@/lib/db/queries/contracts";
import { formatDateTime, formatQuantity } from "@/lib/db/queries/format";
import type { CaseListResult, CaseSummary } from "@/lib/db/queries/cases";
import { humanLabel, labels } from "@/lib/ui/labels";
import { Disclosure } from "./ui/Disclosure";
import { LiveRegion } from "./LiveRegion";
import { StatusBadge } from "./StatusBadge";
import styles from "./case-queue.module.css";

const phaseLabels = labels.phase;
const severityLabels = labels.severity;
type FilterState = Omit<CaseListQuery, "limit" | "cursor">;

function encodeFilters(filters: FilterState, cursor?: string | null): string {
  const params = new URLSearchParams();
  for (const phase of filters.phase ?? []) params.append("phase", phase);
  for (const severity of filters.severity ?? []) params.append("severity", severity);
  if (filters.assignee) params.set("assignee", filters.assignee);
  if (filters.supplier) params.set("supplier", filters.supplier);
  if (filters.item) params.set("item", filters.item);
  if (filters.needs_my_decision) params.set("needs_my_decision", "true");
  if (filters.data_stale) params.set("data_stale", "true");
  if (filters.uncertain_action) params.set("uncertain_action", "true");
  if (filters.closed_outcome) params.set("closed_outcome", filters.closed_outcome);
  if (filters.q) params.set("q", filters.q);
  if (filters.include_closed) params.set("include_closed", "true");
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}

function hasFilters(filters: FilterState): boolean {
  return Boolean(
    filters.q || filters.phase?.length || filters.severity?.length || filters.assignee ||
    filters.supplier || filters.item || filters.needs_my_decision || filters.data_stale ||
    filters.uncertain_action || filters.closed_outcome || filters.include_closed,
  );
}

function toneForSeverity(severity: string): "danger" | "warning" | "neutral" {
  if (severity === "critical" || severity === "urgent") return "danger";
  if (severity === "warning") return "warning";
  return "neutral";
}

function apiUrl(filters: FilterState, cursor?: string | null): string {
  const query = encodeFilters(filters, cursor);
  return `/api/v1/cases${query ? `?${query}` : ""}`;
}

async function fetchCases(filters: FilterState, cursor?: string | null): Promise<CaseListResult> {
  const response = await fetch(apiUrl(filters, cursor), { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error("case_fetch_failed");
  const envelope = await response.json() as { data?: CaseListResult };
  if (!envelope.data) throw new Error("case_fetch_failed");
  return envelope.data;
}

export function CaseQueue({
  initialData,
  initialFilters,
  initialError = false,
  userId,
}: {
  initialData: CaseListResult | null;
  initialFilters: FilterState;
  initialError?: boolean;
  userId: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const requestNumber = useRef(0);
  const [result, setResult] = useState(initialData);
  const [filters, setFilters] = useState<FilterState>(initialFilters);
  const [searchDraft, setSearchDraft] = useState(initialFilters.q ?? "");
  const [loading, setLoading] = useState(!initialData && !initialError);
  const [error, setError] = useState(initialError);
  const [refreshError, setRefreshError] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);

  const matchingLabel = result
    ? `${result.total_matching} matching ${result.total_matching === 1 ? "case" : "cases"}`
    : "";
  const displayTimeZone = result?.items[0]?.location.timezone ?? "UTC";
  const isFiltered = hasFilters(filters);
  const caseRows = useMemo(() => result?.items ?? [], [result]);
  const replayCase = caseRows.find((item) => item.data_label === "Replay");
  const activeFilterCount = Number(Boolean(filters.severity?.length)) +
    Number(Boolean(filters.assignee)) + Number(Boolean(filters.supplier)) +
    Number(Boolean(filters.item)) + Number(Boolean(filters.data_stale)) +
    Number(Boolean(filters.uncertain_action)) + Number(Boolean(filters.closed_outcome)) +
    Number(Boolean(filters.include_closed));

  async function load(nextFilters: FilterState, announce: boolean, append = false) {
    const requestId = ++requestNumber.current;
    if (append) setLoadingMore(true);
    else if (result) setRefreshError(false);
    else setLoading(true);
    setError(false);
    try {
      const data = await fetchCases(nextFilters, append ? result?.next_cursor : null);
      if (requestId !== requestNumber.current) return;
      setResult((previous) => append && previous
        ? { ...data, items: [...previous.items, ...data.items] }
        : data);
      setRefreshError(false);
      if (announce) {
        setAnnouncement(`${data.total_matching} matching ${data.total_matching === 1 ? "case" : "cases"}`);
      }
    } catch {
      if (requestId !== requestNumber.current) return;
      if (result) setRefreshError(true);
      else setError(true);
    } finally {
      if (requestId === requestNumber.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }

  function updateFilters(next: FilterState) {
    setFilters(next);
    const query = encodeFilters(next);
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    void load(next, true);
  }

  useEffect(() => {
    if (!initialData && !initialError) {
      const timer = window.setTimeout(() => void load(initialFilters, false), 0);
      return () => window.clearTimeout(timer);
    }
    // Initial server data is stable for the mounted queue; filter actions own later refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (searchDraft === (filters.q ?? "")) return;
    const timer = window.setTimeout(() => {
      updateFilters({ ...filters, q: searchDraft.trim() || undefined });
    }, 250);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchDraft]);

  function clearFilters() {
    setSearchDraft("");
    updateFilters({});
  }

  function renderCaseBadges(item: CaseSummary, includePhase = true) {
    return (
      <div className={styles.badges}>
        {includePhase && <StatusBadge>{humanLabel("phase", item.phase)}</StatusBadge>}
        {item.run_control !== "active" && (
          <StatusBadge tone={item.run_control === "blocked" ? "warning" : "neutral"}>
            {humanLabel("runControl", item.run_control)}{item.block_reason ? `: ${humanLabel("blockReason", item.block_reason)}` : ""}
          </StatusBadge>
        )}
        <StatusBadge tone={toneForSeverity(item.severity)}>{humanLabel("severity", item.severity)}</StatusBadge>
        {item.data_stale && <StatusBadge tone="warning">Data stale</StatusBadge>}
        {item.has_uncertain_action && <StatusBadge tone="warning">Outcome unknown</StatusBadge>}
      </div>
    );
  }

  function renderCaseTitle(item: CaseSummary) {
    return (
      <Link className={styles.caseLink} href={`/cases/${item.id}`}>
        {item.title || item.item.sku || "Unknown case"}
      </Link>
    );
  }

  function renderTableRow(item: CaseSummary) {
    return (
      <tr key={item.id}>
        <td>
          {renderCaseTitle(item)}
          <span className={styles.caseId}>Case {item.id.slice(0, 8)}</span>
          <div className={styles.badges}>
            <StatusBadge tone={toneForSeverity(item.severity)}>{humanLabel("severity", item.severity)}</StatusBadge>
          </div>
        </td>
        <td>{item.suppliers.map((supplier) => supplier.name).join(", ") || "Unknown"}</td>
        <td>{formatDateTime(item.first_shortage_at, item.location.timezone) ?? item.shortage_label ?? "Unknown"}</td>
        <td>{formatQuantity(item.bridge_quantity, item.item.unit) ?? "Unknown"}</td>
        <td><StatusBadge>{humanLabel("phase", item.phase)}</StatusBadge></td>
        <td>{item.next_action.label}</td>
        <td>{item.assignee?.email ?? "Unassigned"}</td>
        <td>{item.data_stale && <StatusBadge tone="warning">Data stale</StatusBadge>}</td>
      </tr>
    );
  }

  return (
    <div className={styles.queue} data-state={loading && !result ? "loading" : error ? "failed-fetch" : refreshError ? "failed-refresh" : !caseRows.length && !isFiltered ? "empty-org" : !caseRows.length ? "filtered-empty" : "ready"}>
      <header className={styles.pageHeader}>
        <div>
          <h1>Cases</h1>
          <p>Review supplier delays, business impact, and recovery work.</p>
        </div>
      </header>
      {replayCase?.replay_clock && (
        <p className={styles.replayClock} role="status">
          Replay clock: {formatDateTime(replayCase.replay_clock, replayCase.location.timezone)}
        </p>
      )}
      <section aria-label="Case summary" className={styles.summaryGrid}>
        {[
          {
            label: "Active shortages",
            value: result?.summary.active_shortages ?? 0,
            denominator: `of ${result?.summary.active_cases ?? 0} active ${(result?.summary.active_cases ?? 0) === 1 ? "case" : "cases"}`,
            filters: { ...filters, phase: (Object.keys(phaseLabels) as NonNullable<CaseListQuery["phase"]>).filter((phase) => phase !== "closed"), include_closed: undefined },
          },
          {
            label: "Decisions waiting",
            value: result?.summary.decisions_waiting ?? 0,
            denominator: `of ${result?.summary.active_cases ?? 0} active ${(result?.summary.active_cases ?? 0) === 1 ? "case" : "cases"}`,
            filters: { ...filters, needs_my_decision: true },
          },
          {
            label: "Outcome unclear",
            value: result?.summary.uncertain_actions ?? 0,
            denominator: `of ${result?.summary.active_cases ?? 0} active ${(result?.summary.active_cases ?? 0) === 1 ? "case" : "cases"}`,
            filters: { ...filters, uncertain_action: true },
          },
          {
            label: "Recoveries recorded",
            value: result?.summary.recoveries_recorded ?? 0,
            denominator: `of ${result?.summary.total_cases ?? 0} ${(result?.summary.total_cases ?? 0) === 1 ? "case" : "cases"}`,
            filters: { ...filters, phase: ["monitoring", "closed"] as NonNullable<CaseListQuery["phase"]>, include_closed: true },
          },
        ].map(({ label, value, denominator, filters: tileFilters }) => (
          <article className={styles.summaryTile} key={label}>
            <button aria-label={`Filter by ${label}`} onClick={() => updateFilters(tileFilters)} type="button">
              <span>{label}</span><strong>{value}</strong><small>{denominator}</small>
            </button>
          </article>
        ))}
      </section>

      <Disclosure className={styles.filterDisclosure} responsiveAtWidth={639} summary="Filters">
      <form
        className={styles.filters}
        onSubmit={(event) => {
          event.preventDefault();
          updateFilters({ ...filters, q: searchDraft.trim() || undefined });
        }}
        role="search">
        <label className={styles.searchLabel}>
          Search by PO, SKU, supplier or case ID
          <input
            autoComplete="off"
            onChange={(event) => setSearchDraft(event.target.value)}
            value={searchDraft}
          />
        </label>
        <label className={styles.mainFilter}>
          Phase
          <select
            onChange={(event) => updateFilters({ ...filters, phase: event.target.value ? [event.target.value as NonNullable<CaseListQuery["phase"]>[number]] : undefined })}
            value={filters.phase?.length === 1 ? filters.phase[0] : ""}
          >
            <option value="">Any phase</option>
            {(Object.entries(phaseLabels) as [keyof typeof phaseLabels, string][]).map(([phase, label]) => (
              <option key={phase} value={phase}>{label} ({result?.counts.by_phase[phase as keyof CaseListResult["counts"]["by_phase"]] ?? 0})</option>
            ))}
          </select>
        </label>
        <label className={styles.decisionToggle}>
          <input checked={Boolean(filters.needs_my_decision)} onChange={(event) => updateFilters({ ...filters, needs_my_decision: event.target.checked || undefined })} type="checkbox" />
          Needs my decision
        </label>
        <div className={styles.moreFilters}>
          <Disclosure count={activeFilterCount || undefined} summary="More filters">
            <div className={styles.secondaryFilters}>
              <label>
                Severity
                <select onChange={(event) => { const severity = event.target.value as keyof typeof severityLabels | ""; updateFilters({ ...filters, severity: severity ? [severity] : undefined }); }} value={filters.severity?.[0] ?? ""}>
                  <option value="">Any severity</option>
                  {(Object.entries(severityLabels) as [keyof typeof severityLabels, string][]).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                </select>
              </label>
              <label>
                Assignee
                <select onChange={(event) => updateFilters({ ...filters, assignee: event.target.value || undefined })} value={filters.assignee ?? ""}>
                  <option value="">Anyone</option><option value="me">Me</option><option value="unassigned">Unassigned</option>
                  {[...new Map(caseRows.flatMap((item) => item.assignee ? [[item.assignee.user_id, item.assignee.email ?? item.assignee.user_id] as const] : [])).entries()]
                    .filter(([id]) => id !== userId).map(([id, email]) => <option key={id} value={id}>{email}</option>)}
                </select>
              </label>
              <label>
                Supplier
                <select onChange={(event) => updateFilters({ ...filters, supplier: event.target.value || undefined })} value={filters.supplier ?? ""}>
                  <option value="">Any supplier</option>
                  {[...new Map(caseRows.flatMap((item) => item.suppliers.map((supplier) => [supplier.id, supplier.name] as const))).entries()]
                    .map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                </select>
              </label>
              <label>
                Item
                <select onChange={(event) => updateFilters({ ...filters, item: event.target.value || undefined })} value={filters.item ?? ""}>
                  <option value="">Any item</option>
                  {[...new Map(caseRows.map((item) => [item.item.id, item.item.sku] as const)).entries()].map(([id, sku]) => <option key={id} value={id}>{sku}</option>)}
                </select>
              </label>
              <label className={styles.secondaryToggle}><input checked={Boolean(filters.data_stale)} onChange={(event) => updateFilters({ ...filters, data_stale: event.target.checked || undefined })} type="checkbox" />Data stale</label>
              <label className={styles.secondaryToggle}><input checked={Boolean(filters.uncertain_action)} onChange={(event) => updateFilters({ ...filters, uncertain_action: event.target.checked || undefined })} type="checkbox" />Uncertain action</label>
              <label>
                Closed outcome
                <select onChange={(event) => updateFilters({ ...filters, closed_outcome: event.target.value as FilterState["closed_outcome"] || undefined })} value={filters.closed_outcome ?? ""}>
                  <option value="">Any outcome</option>
                  {["delivered", "no_impact", "accepted_risk", "cancelled", "unresolved"].map((outcome) => <option key={outcome} value={outcome}>{humanLabel("caseOutcome", outcome)}</option>)}
                </select>
              </label>
              <label className={styles.secondaryToggle}><input checked={Boolean(filters.include_closed)} onChange={(event) => updateFilters({ ...filters, include_closed: event.target.checked || undefined })} type="checkbox" />Include closed cases</label>
            </div>
          </Disclosure>
        </div>
        {isFiltered && <button className={styles.clearButton} onClick={clearFilters} type="button">Clear filters</button>}
      </form>
      </Disclosure>

      <div className={styles.resultsHead}>
        <p>{result ? matchingLabel : "Loading cases…"}</p>
        <LiveRegion message={announcement} />
      </div>
      {result?.items.some((item) => item.data_stale) && (
        <p className={styles.staleBanner} role="status">Some business data is out of date — figures may have changed.</p>
      )}
      {refreshError && (
        <p className={styles.refreshBanner} role="status">
          Couldn’t refresh. Showing the list from {formatDateTime(result?.refreshed_at ?? null, displayTimeZone) ?? "Unknown"}.
          <button onClick={() => void load(filters, false)} type="button">Retry</button>
        </p>
      )}
      {error && !result && (
        <div className={styles.errorState} data-state="failed-initial" role="alert">
          <p>Couldn’t load cases. Check your connection and try again.</p>
          <button onClick={() => void load(filters, false)} type="button">Retry</button>
        </div>
      )}
      {loading && !result && <div className={styles.skeleton} data-state="loading" aria-label="Loading cases">{[1, 2, 3].map((row) => <div key={row} />)}</div>}
      {!loading && result && caseRows.length === 0 && !error && (
        <section className={styles.emptyState} data-state={isFiltered ? "filtered-empty" : "empty-org"}>
          {isFiltered ? (
            <>
              <h2>No cases match these filters.</h2>
              <button onClick={clearFilters} type="button">Clear filters</button>
            </>
          ) : (
            <>
              <h2>No supplier delays yet. Conduit opens a case when a supplier reports a delay.</h2>
              <div><Link href="/business-data">Business data</Link></div>
            </>
          )}
        </section>
      )}
      {caseRows.length > 0 && (
        <>
          <div className={styles.desktopTable}>
            <table>
              <thead><tr><th scope="col">Case</th><th scope="col">Supplier</th><th scope="col">First shortage</th><th scope="col">At risk</th><th scope="col">Phase</th><th scope="col">Next action</th><th scope="col">Assignee</th><th scope="col">Data</th></tr></thead>
              <tbody>{caseRows.map(renderTableRow)}</tbody>
            </table>
          </div>
          <ul className={styles.mobileCards}>
            {caseRows.map((item) => (
              <li key={item.id}>
                <article className={styles.caseCard}>
                  {renderCaseTitle(item)}
                  <span className={styles.caseId}>Case {item.id.slice(0, 8)}</span>
                  {renderCaseBadges(item)}
                  <dl>
                    <div><dt>Supplier</dt><dd>{item.suppliers.map((supplier) => supplier.name).join(", ") || "Unknown"}</dd></div>
                    <div><dt>First shortage</dt><dd>{formatDateTime(item.first_shortage_at, item.location.timezone) ?? item.shortage_label ?? "Unknown"}</dd></div>
                    <div><dt>At risk</dt><dd>{formatQuantity(item.bridge_quantity, item.item.unit) ?? "Unknown"}</dd></div>
                    <div><dt>Next action</dt><dd>{item.next_action.label}</dd></div>
                    <div><dt>Assignee</dt><dd>{item.assignee?.email ?? "Unassigned"}</dd></div>
                  </dl>
                </article>
              </li>
            ))}
          </ul>
          {result?.next_cursor && (
            <button className={styles.loadMore} disabled={loadingMore} onClick={() => void load(filters, false, true)} type="button">
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          )}
        </>
      )}
    </div>
  );
}
