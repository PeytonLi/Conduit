"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type {
  CaseDetail,
  CaseEvidence,
  OptionRow,
  TimelineEntry,
} from "@/lib/db/queries/cases";
import { formatDateTime, formatDateTimeRange, formatMoney, formatQuantity, formatQuantityChange } from "@/lib/db/queries/format";
import { humanLabel, originalOrderTreatmentLabel } from "@/lib/ui/labels";
import { Disclosure } from "./ui/Disclosure";
import { RequestReassessmentButton } from "./RequestReassessmentButton";
import { CaseControls } from "./CaseControls";
import { EvidenceDrawer } from "./EvidenceDrawer";
import { QuoteCorrectionForm } from "./QuoteCorrectionForm";
import { StatusBadge } from "./StatusBadge";
import { ApprovalCard } from "./ApprovalCard";
import { OutreachForm } from "./OutreachForm";
import { Icon } from "./ui/Icon";
import styles from "./case-detail.module.css";

function severityTone(severity: string): "danger" | "warning" | "neutral" {
  if (severity === "critical" || severity === "urgent") return "danger";
  if (severity === "warning") return "warning";
  return "neutral";
}

function timelineStatusLabel(status: string): string {
  return status === "unknown" ? "Needs review" : humanLabel("timelineStatus", status);
}

function quantityLabel(value: number | null, unit: string): string {
  return formatQuantity(value, unit) ?? "Not provided";
}

function moneyLabel(value: string | null, currency: string | null): string {
  return formatMoney(value, currency ?? "USD") ?? "Needs a price";
}

function displayBalance(value: number, unit: string): string {
  const formatted = formatQuantity(Math.abs(value), unit) ?? "Not available";
  return value < 0 ? `−${formatted} (short)` : formatted;
}

function sourceLink(
  evidence: CaseEvidence | undefined,
  timeZone: string,
  label = "View source",
) {
  return evidence ? <EvidenceDrawer evidence={evidence} label={label} timeZone={timeZone} /> : null;
}

function StockProjection({
  detail,
}: {
  detail: CaseDetail;
}) {
  const points = detail.assessment?.points ?? [];
  const width = 640;
  const height = 180;
  const padding = 20;
  const balances = points.map((point) => point.balance);
  const minBalance = Math.min(0, ...balances);
  const maxBalance = Math.max(0, ...balances);
  const span = maxBalance - minBalance || 1;
  const chartPoints = points.map((point, index) => {
    const x = points.length <= 1
      ? width / 2
      : padding + index * ((width - 2 * padding) / (points.length - 1));
    const y = height - padding - ((point.balance - minBalance) / span) * (height - 2 * padding);
    return { x, y, point };
  });
  const zeroY = height - padding - ((0 - minBalance) / span) * (height - 2 * padding);
  const linePoints = chartPoints.map(({ x, y }) => `${x},${y}`).join(" ");
  const firstShort = chartPoints.find(({ point }) => point.balance < 0);
  const chartId = `projection-title-${detail.case.id}`;
  const unit = detail.case.item.unit;
  const timeZone = detail.case.location.timezone;

  if (!points.length) {
    return (
      <section aria-labelledby={chartId} className={styles.projection}>
        <h3 id={chartId}>Projected usable stock</h3>
        <p>No stock projection is available for this case.</p>
      </section>
    );
  }

  return (
    <section aria-labelledby={chartId} className={styles.projection}>
      <figure>
        <figcaption id={chartId}>Projected usable stock</figcaption>
        <p className={styles.chartSummary}>
          Projected balance ranges from {displayBalance(minBalance, unit)} to {displayBalance(maxBalance, unit)}.
        </p>
        <svg
          aria-hidden="true"
          className={styles.chart}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
        >
          <g aria-hidden="true">
            <line className={styles.zeroLine} x1={padding} x2={width - padding} y1={zeroY} y2={zeroY} />
            <text className={styles.chartLabel} x={padding + 4} y={zeroY - 5}>0</text>
            {linePoints && <polyline className={styles.projectionLine} points={linePoints} />}
            {firstShort && <circle className={styles.shortageMark} cx={firstShort.x} cy={firstShort.y} r="6" />}
            {chartPoints.map(({ x, point }, index) => (
              <text
                className={styles.chartLabel}
                key={`${point.at}-${index}`}
                textAnchor={index === 0 ? "start" : index === chartPoints.length - 1 ? "end" : "middle"}
                x={x}
                y={height - 2}
              >
                {new Intl.DateTimeFormat("en-US", { weekday: "short", day: "numeric", timeZone }).format(new Date(point.at))}
              </text>
            ))}
          </g>
        </svg>
      </figure>
      <Disclosure summary="Show as table">
        <div className={styles.tableWrap}>
          <table>
            <caption>Projected usable stock ({unit}, {detail.case.location.timezone})</caption>
            <thead><tr><th scope="col">Time</th><th scope="col">Event</th><th scope="col">Change</th><th scope="col">Projected balance</th></tr></thead>
            <tbody>
              {points.map((point, index) => (
                <tr key={`${point.at}-${index}`}>
                  <td>{formatDateTime(point.at, detail.case.location.timezone) ?? "Not available"}</td>
                  <td>{point.label || humanLabel("projectionKind", point.kind)}</td>
                  <td>{formatQuantityChange(point.delta, unit) ?? "Not available"}</td>
                  <td>{displayBalance(point.balance, unit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Disclosure>
    </section>
  );
}

function ImpactSummary({
  detail,
  evidence,
}: {
  detail: CaseDetail;
  evidence: CaseEvidence[];
}) {
  const assessment = detail.assessment;
  const source = evidence.find((entry) => /inventory|receipt|stock/i.test(entry.purpose));
  const sourceTimes = [
    detail.case.source_as_of
      ? `Source data as of ${formatDateTime(detail.case.source_as_of, detail.case.location.timezone)}`
      : null,
    detail.assessment?.assessed_at
      ? `Assessed ${formatDateTime(detail.assessment.assessed_at, detail.case.location.timezone)}`
      : null,
    detail.case.replay_clock
      ? `Replay clock ${formatDateTime(detail.case.replay_clock, detail.case.location.timezone)}`
      : null,
  ].filter((value): value is string => value !== null);
  return (
    <section aria-labelledby="impact-summary-heading" className={styles.impactSummary}>
      <h2 id="impact-summary-heading">Impact</h2>
      {sourceTimes.length > 0 && <p className={styles.sourceTimes}>{sourceTimes.join(" · ")}</p>}
      <div className={styles.impactGrid}>
        <div className={styles.impactFacts}>
          <dl className={styles.factList}>
            <div><dt>Shortage quantity</dt><dd>{quantityLabel(assessment?.bridge_quantity ?? null, detail.case.item.unit)} {sourceLink(source, detail.case.location.timezone)}</dd></div>
            <div><dt>First shortage</dt><dd>{formatDateTime(assessment?.first_shortage_at ?? null, detail.case.location.timezone) ?? "Not available"} {sourceLink(source, detail.case.location.timezone)}</dd></div>
            <div><dt>Assessment horizon</dt><dd>{formatDateTimeRange(assessment?.horizon_start ?? null, assessment?.horizon_end ?? null, detail.case.location.timezone) ?? "Not available"}</dd></div>
          </dl>
          <h3>Original and revised receipts</h3>
          {detail.order_lines.length ? (
            <ul className={styles.receipts}>
              {detail.order_lines.map((line) => (
                <li key={line.po_line_id}>
                  <strong>{line.po} · line {line.line}</strong>
                  {line.original_due_at && <span>Original due: {formatDateTime(line.original_due_at, detail.case.location.timezone)}</span>}
                  {line.revised_receipts.length ? line.revised_receipts.map((receipt) => (
                    <span key={receipt.id}>
                      Revised: {quantityLabel(receipt.quantity, detail.case.item.unit)} · {formatDateTimeRange(receipt.earliest_at, receipt.latest_at, detail.case.location.timezone) ?? "Not confirmed yet"}
                      {sourceLink(evidence.find((entry) => entry.purpose.includes(receipt.id)) ?? source, detail.case.location.timezone)}
                    </span>
                  )) : <span>Revised receipt: Not confirmed yet</span>}
                </li>
              ))}
            </ul>
          ) : <p>No purchase-order receipt details are available.</p>}
          {assessment?.missing_facts.length ? (
            <div className={styles.missingFacts}>
              <h3>Missing facts</h3>
              <ul>{assessment.missing_facts.map((fact) => <li key={fact}>{humanLabel("missingQuoteTerm", fact)}: Needs confirmation</li>)}</ul>
            </div>
          ) : null}
        </div>
        <StockProjection detail={detail} />
      </div>
    </section>
  );
}

function SupplierOptionTable({
  options,
  evidence,
  detail,
}: {
  options: OptionRow[];
  evidence: CaseEvidence[];
  detail: CaseDetail;
}) {
  const groups = [
    ["feasible", "Feasible"],
    ["incomplete", "Incomplete"],
    ["rejected", "Rejected"],
  ] as const;
  const costRows: [string, keyof OptionRow["costs"]][] = [
    ["Item", "item_cost_minor"],
    ["Freight", "freight_minor"],
    ["Fees", "fees_minor"],
    ["Non-recoverable tax", "nonrecoverable_tax_minor"],
    ["Cancellation", "cancellation_minor"],
    ["Credits", "credits_minor"],
    ["Total cash outlay", "total_cash_outlay_minor"],
    ["Net incremental", "net_incremental_minor"],
  ];

  return (
    <section aria-labelledby="options-heading" className={styles.options}>
      <h2 id="options-heading">Recovery options</h2>
      {groups.map(([feasibility, label]) => {
        const groupOptions = options.filter((option) => option.feasibility === feasibility);
        return (
          <section aria-labelledby={`option-group-${feasibility}`} className={styles.optionGroup} key={feasibility}>
            <h3 id={`option-group-${feasibility}`}>{label}</h3>
            {groupOptions.length === 0 ? <p>No {label.toLowerCase()} options.</p> : groupOptions.map((option) => (
              <article className={styles.optionCard} key={option.id}>
                <header className={styles.optionHeader}>
                  <div><h4>{option.supplier.name || "Supplier name unavailable"}</h4><StatusBadge tone={feasibility === "feasible" ? "success" : feasibility === "rejected" ? "danger" : "warning"}>{label}</StatusBadge></div>
                </header>
                <dl className={styles.optionSummary}>
                  <div><dt>Quantity and arrival</dt><dd>{option.quantity === null ? "Not provided" : formatQuantity(option.quantity, detail.case.item.unit)}
                    {option.schedule.map((entry, index) => <span key={`${option.id}-summary-${index}`}> · by {formatDateTimeRange(entry.arrival_start, entry.arrival_end, detail.case.location.timezone) ?? "arrival not confirmed"}</span>)}
                  </dd></div>
                  <div><dt>Total cash outlay</dt><dd>{moneyLabel(option.costs.total_cash_outlay_minor, option.currency)}</dd></div>
                  <div><dt>Net incremental</dt><dd>{moneyLabel(option.costs.net_incremental_minor, option.currency)}</dd></div>
                </dl>
                <Disclosure summary="Details">
                  <p className={styles.optionContext}>{option.item_sku || "Item details unavailable"} · {option.location ?? "Location unavailable"}</p>
                <dl className={styles.optionFacts}>
                  <div><dt>Purchasing status</dt><dd>{humanLabel("supplierStatus", option.supplier.purchasing_status)}</dd></div>
                  <div><dt>Specification status</dt><dd>{humanLabel("specificationStatus", option.specification_status)}</dd></div>
                  <div><dt>Quantity and schedule</dt><dd>{option.quantity === null ? "Not provided" : formatQuantity(option.quantity, detail.case.item.unit)}
                    {option.schedule.map((entry, index) => <span key={`${option.id}-schedule-${index}`}> · {formatQuantity(entry.quantity, detail.case.item.unit)} by {formatDateTimeRange(entry.arrival_start, entry.arrival_end, detail.case.location.timezone) ?? "arrival not confirmed"}</span>)}
                  </dd></div>
                  <div><dt>Quote validity</dt><dd>{formatDateTime(option.valid_until, detail.case.location.timezone) ?? "Not provided"}</dd></div>
                  <div><dt>Latest order time</dt><dd>{formatDateTime(option.latest_order_at, detail.case.location.timezone) ?? "Not provided"}</dd></div>
                  <div><dt>Written confirmation</dt><dd>{option.written_confirmation ? "Yes" : "No"}</dd></div>
                  <div><dt>Original order treatment</dt><dd>{originalOrderTreatmentLabel(option.original_order_treatment, detail.case.purchase_orders[0])}</dd></div>
                  <div><dt>Surplus</dt><dd>{quantityLabel(option.surplus_quantity, detail.case.item.unit)}</dd></div>
                </dl>
                {option.reasons.length > 0 && <div className={styles.reasons}><strong>Constraints and reasons</strong><ul>{option.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></div>}
                {option.missing_fields.length > 0 && <p className={styles.missingOption}>Missing: {option.missing_fields.map((field) => humanLabel("missingQuoteTerm", field)).join(", ")}</p>}
                <dl className={styles.costs}>
                  {costRows.map(([label, key]) => (
                    <div key={key}><dt>{label}</dt><dd>{moneyLabel(option.costs[key], option.currency)}</dd></div>
                  ))}
                </dl>
                {option.last_verified_at && <p className={styles.verified}>Last verified: {formatDateTime(option.last_verified_at, detail.case.location.timezone)}</p>}
                {[...new Set(option.evidence_ids)].length > 0 && (
                  <ul className={styles.sourceLinks}>
                    {[...new Set(option.evidence_ids)].flatMap((evidenceId, index) => {
                      const source = evidence.find((entry) => entry.id === evidenceId);
                      return source ? (
                        <li key={evidenceId}>
                          <EvidenceDrawer evidence={source} label={`Source ${index + 1}`} timeZone={detail.case.location.timezone} />
                        </li>
                      ) : [];
                    })}
                  </ul>
                )}
                {detail.permissions.can_correct_quote && (
                  <QuoteCorrectionForm
                    evidenceOptions={option.evidence_ids.map((id) => {
                      const source = evidence.find((entry) => entry.id === id);
                      return { id, label: source ? humanLabel("evidenceSourceType", source.source_type) : "Source unavailable" };
                    })}
                    expectedVersion={detail.case.row_version}
                    originalText={option.evidence_ids.map((id) => evidence.find((entry) => entry.id === id)?.supported_excerpt).filter(Boolean).join("\n\n")}
                    quoteId={option.quote_id}
                    timezone={detail.case.location.timezone}
                  />
                )}
                </Disclosure>
              </article>
            ))}
          </section>
        );
      })}
    </section>
  );
}

function SupplierContact({
  timeline,
  detail,
  environmentMode,
  canOutreach,
}: {
  timeline: TimelineEntry[];
  detail: CaseDetail;
  environmentMode: "live" | "sandbox" | "replay";
  canOutreach: boolean;
}) {
  const callActions = timeline.filter((entry) => entry.group === "call_outcome");
  const isReplay = detail.case.data_label === "Replay" ||
    (detail.case.data_label === null && environmentMode === "replay");
  return (
    <section aria-labelledby="calls-heading" className={styles.calls}>
      <h2 id="calls-heading">Supplier outreach</h2>
      {callActions.length ? (
        <ul>{callActions.map((call) => <li key={call.id}>{call.title} · {call.actor.label} · {timelineStatusLabel(call.status)}</li>)}</ul>
      ) : <p>No calls for this case.</p>}
      {canOutreach && detail.supplier_contacts.length > 0
        ? <OutreachForm
            caseId={detail.case.id}
            contacts={detail.supplier_contacts}
            isReplay={isReplay || environmentMode === "sandbox"}
          />
        : !detail.supplier_contacts.length && <p>No supplier contacts are available for this case.</p>}
    </section>
  );
}

function CaseHistory({
  timeline,
  evidence,
  detail,
  organizationTimeZone,
  environmentMode,
  planEvidence,
}: {
  timeline: TimelineEntry[];
  evidence: CaseEvidence[];
  detail: CaseDetail;
  organizationTimeZone: string;
  environmentMode: "live" | "sandbox" | "replay";
  planEvidence: CaseEvidence[];
}) {
  const orderedTimeline = [...timeline].sort((left, right) =>
    new Date(right.at).getTime() - new Date(left.at).getTime(),
  );
  const visibleTimeline = orderedTimeline.slice(0, 5);
  const additionalTimeline = orderedTimeline.slice(5);
  const isReplay = detail.case.data_label === "Replay" ||
    (detail.case.data_label === null && environmentMode === "replay");
  const renderEntries = (entries: TimelineEntry[]) => (
    <ol>
      {entries.map((entry) => {
        const status = timelineStatusLabel(entry.status);
        const tone = status === "Failed" ? "danger" : status === "Needs review" ? "warning" : "neutral";
        return (
          <li key={entry.id}>
            <div className={styles.timelineHeading}>
              <h3>{entry.title}</h3>
              <StatusBadge tone={tone}>{status}</StatusBadge>
            </div>
            <dl>
              <div><dt>Time</dt><dd>{formatDateTime(entry.at, organizationTimeZone) ?? "Not available"}</dd></div>
              <div><dt>Actor</dt><dd>{entry.actor.label}</dd></div>
            </dl>
            {isReplay && entry.action_ref && <StatusBadge>Replay</StatusBadge>}
            {[...new Set(entry.evidence_ids)].length > 0 && (
              <ul className={styles.sourceLinks}>
                {[...new Set(entry.evidence_ids)].flatMap((id, index) => {
                  const source = evidence.find((item) => item.id === id);
                  return source ? (
                    <li key={id}>
                      <EvidenceDrawer evidence={source} label={`Source ${index + 1}`} timeZone={detail.case.location.timezone} />
                    </li>
                  ) : [];
                })}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
  return (
    <>
      <section aria-labelledby="timeline-heading" className={styles.timeline}>
        <h2 id="timeline-heading">Timeline</h2>
        {visibleTimeline.length ? renderEntries(visibleTimeline) : <p>No recorded activity yet.</p>}
        {additionalTimeline.length > 0 && (
          <Disclosure summary={`Show all (${orderedTimeline.length})`}>
            {renderEntries(additionalTimeline)}
          </Disclosure>
        )}
      </section>
      <section aria-labelledby="evidence-heading" className={styles.evidenceList}>
        <h2 id="evidence-heading">Evidence</h2>
        {evidence.length ? (
          <div className={styles.tableWrap}>
            <table>
              <caption>Sources linked to this case</caption>
              <thead>
                <tr><th scope="col">Source</th><th scope="col">What it supports</th><th scope="col">Source time</th><th scope="col">Open</th></tr>
              </thead>
              <tbody>
                {evidence.map((entry) => (
                  <tr key={`${entry.id}:${entry.purpose}`}>
                    <td>{humanLabel("evidenceSourceType", entry.source_type)}</td>
                    <td>{humanLabel("evidencePurpose", entry.purpose)}</td>
                    <td>{formatDateTime(entry.source_time, detail.case.location.timezone) ?? "Not available"}</td>
                    <td><EvidenceDrawer evidence={entry} label="Open" timeZone={detail.case.location.timezone} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p>No evidence is linked to this case.</p>}
        {planEvidence.length > 0 && <p>{planEvidence.length} source{planEvidence.length === 1 ? "" : "s"} support the current plan.</p>}
      </section>
    </>
  );
}

type CaseTab = "overview" | "options" | "contact" | "history";

const caseTabs: { id: CaseTab; label: string; count?: number }[] = [
  { id: "overview", label: "Overview" },
  { id: "options", label: "Options" },
  { id: "contact", label: "Supplier contact" },
  { id: "history", label: "History" },
];

function CaseSections({
  caseId,
  initialTab,
  optionsCount,
  historyCount,
  panels,
}: {
  caseId: string;
  initialTab?: string;
  optionsCount: number;
  historyCount: number;
  panels: Record<CaseTab, ReactNode>;
}) {
  const [activeTab, setActiveTab] = useState<CaseTab>(() =>
    caseTabs.some((tab) => tab.id === initialTab) ? initialTab as CaseTab : "overview",
  );
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const tabsScroller = useRef<HTMLDivElement | null>(null);
  const panelCounts: Partial<Record<CaseTab, number>> = {
    options: optionsCount,
    history: historyCount,
  };

  useEffect(() => {
    const scroller = tabsScroller.current;
    const selectedTab = tabRefs.current[caseTabs.findIndex((tab) => tab.id === activeTab)];
    if (!scroller || !selectedTab) return;
    const scrollerRect = scroller.getBoundingClientRect();
    const tabRect = selectedTab.getBoundingClientRect();
    if (tabRect.left < scrollerRect.left) {
      scroller.scrollLeft += tabRect.left - scrollerRect.left;
    } else if (tabRect.right > scrollerRect.right) {
      scroller.scrollLeft += tabRect.right - scrollerRect.right;
    }
  }, [activeTab]);

  function activateTab(tab: CaseTab) {
    setActiveTab(tab);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % caseTabs.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + caseTabs.length) % caseTabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = caseTabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextTab = caseTabs[nextIndex];
    activateTab(nextTab.id);
    tabRefs.current[nextIndex]?.focus();
  }

  const tabId = (tab: CaseTab) => `case-${caseId}-tab-${tab}`;
  const panelId = (tab: CaseTab) => `case-${caseId}-panel-${tab}`;

  return (
    <section aria-label="Case sections" className={styles.caseSections}>
      <div className={styles.tabsScroller} ref={tabsScroller}>
        <div aria-label="Case sections" className={styles.tabList} role="tablist">
          {caseTabs.map((tab, index) => {
            const count = panelCounts[tab.id];
            return (
              <button
                aria-controls={panelId(tab.id)}
                aria-selected={activeTab === tab.id}
                className={styles.tab}
                id={tabId(tab.id)}
                key={tab.id}
                onClick={() => activateTab(tab.id)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
                ref={(node) => { tabRefs.current[index] = node; }}
                role="tab"
                tabIndex={activeTab === tab.id ? 0 : -1}
                type="button"
              >
                <span>{tab.label}</span>
                {count !== undefined && <span className={styles.tabCount}>({count})</span>}
              </button>
            );
          })}
        </div>
      </div>
      {caseTabs.map((tab) => (
        <div
          aria-labelledby={tabId(tab.id)}
          className={styles.tabPanel}
          hidden={activeTab !== tab.id}
          id={panelId(tab.id)}
          key={tab.id}
          role="tabpanel"
          tabIndex={0}
        >
          {panels[tab.id]}
        </div>
      ))}
    </section>
  );
}

export function CaseDetailView({
  detail,
  options,
  evidence,
  timeline,
  role,
  environmentMode,
  organizationTimeZone,
  initialTab,
}: {
  detail: CaseDetail;
  options: OptionRow[];
  evidence: CaseEvidence[];
  timeline: TimelineEntry[];
  role: "owner" | "operator" | "viewer";
  environmentMode: "live" | "sandbox" | "replay";
  organizationTimeZone: string;
  initialTab?: string;
}) {
  const supportEvidence = evidence.find((item) => /delay|supplier|quote/i.test(item.purpose));
  const planOption = options.find((option) => option.plan_id === detail.plan?.plan_id);
  const planEvidence = detail.plan?.evidence_ids
    .map((id) => evidence.find((item) => item.id === id))
    .filter((item): item is CaseEvidence => item !== undefined) ?? [];
  const titleWithoutPurchaseOrder = detail.case.title
    .split(" · ")
    .filter((part) => !detail.case.purchase_orders.includes(part))
    .join(" · ");
  const caseTitle = titleWithoutPurchaseOrder || detail.case.item.sku || detail.case.title || "Case details";
  const caseContext = [
    detail.case.item.description || detail.case.item.sku,
    detail.case.location.name,
    detail.case.purchase_orders.join(", "),
  ].filter(Boolean);
  return (
    <div className={styles.detail}>
      <header className={styles.caseHeader}>
        <h1>{caseTitle}</h1>
        <p className={styles.caseContext}>{caseContext.join(" · ") || "Case details unavailable"}</p>
        <div className={styles.headerBadges}>
          {detail.case.phase && <StatusBadge>{humanLabel("phase", detail.case.phase)}</StatusBadge>}
          {detail.case.severity && <StatusBadge tone={severityTone(detail.case.severity)}>{humanLabel("severity", detail.case.severity)}</StatusBadge>}
        </div>
        {detail.case.data_stale && (
          <p className={styles.staleWarning} role="status">
            Business data may be out of date.
            {detail.permissions.can_reassess && <RequestReassessmentButton />}
          </p>
        )}
      </header>
      <section aria-label="Case impact" className={styles.impact}>
        <h2><Icon name="alert" aria-hidden="true" />{detail.impact_sentence}</h2>
        <p>{detail.explanation}</p>
        {supportEvidence && <EvidenceDrawer evidence={supportEvidence} label="View impact source" timeZone={detail.case.location.timezone} />}
      </section>
      <aside aria-label="Decision panel" className={styles.decision}>
        <div className={styles.nextAction}>
          <p className={styles.eyebrow}>Next action</p>
          <h2>{detail.case.next_action.label}</h2>
          {detail.case.next_action.due_at && <p>Due: {formatDateTime(detail.case.next_action.due_at, detail.case.location.timezone)}</p>}
        </div>
        {detail.plan ? (
          <ApprovalCard
            canApprove={detail.permissions.can_approve}
            caseSummary={detail.case}
            environmentMode={environmentMode}
            originalOrderTreatment={originalOrderTreatmentLabel(
              planOption?.original_order_treatment ?? "not_specified",
              detail.case.purchase_orders[0],
            )}
            plan={detail.plan}
            role={role}
          />
        ) : <p>No recovery plan is awaiting approval.</p>}
        <CaseControls detail={detail} role={role} />
      </aside>
      <CaseSections
        caseId={detail.case.id}
        historyCount={timeline.length}
        initialTab={initialTab}
        optionsCount={options.length}
        panels={{
          overview: <ImpactSummary detail={detail} evidence={evidence} />,
          options: <SupplierOptionTable detail={detail} evidence={evidence} options={options} />,
          contact: (
            <SupplierContact
              canOutreach={detail.permissions.can_control}
              detail={detail}
              environmentMode={environmentMode}
              timeline={timeline}
            />
          ),
          history: (
            <CaseHistory
              detail={detail}
              environmentMode={environmentMode}
              evidence={evidence}
              organizationTimeZone={organizationTimeZone}
              planEvidence={planEvidence}
              timeline={timeline}
            />
          ),
        }}
      />
    </div>
  );
}
