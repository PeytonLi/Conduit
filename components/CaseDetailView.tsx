import type {
  CaseDetail,
  CaseEvidence,
  OptionRow,
  TimelineEntry,
} from "@/lib/db/queries/cases";
import { formatDateTime, formatMoney, formatQuantity } from "@/lib/db/queries/format";
import { CaseControls } from "./CaseControls";
import { EvidenceDrawer } from "./EvidenceDrawer";
import { QuoteCorrectionForm } from "./QuoteCorrectionForm";
import { StatusBadge } from "./StatusBadge";
import { ApprovalCard } from "./ApprovalCard";
import styles from "./case-detail.module.css";

const phaseLabels: Record<string, string> = {
  new: "New",
  needs_review: "Needs review",
  assessing: "Assessing",
  recovering: "Recovering",
  awaiting_supplier: "Awaiting supplier",
  awaiting_approval: "Awaiting approval",
  executing: "Executing",
  monitoring: "Monitoring",
  closed: "Closed",
};

const groupLabels: Record<TimelineEntry["group"], string> = {
  received_delay: "Supplier delay received",
  matched_order: "Purchase order matched",
  recalculated_stock: "Stock impact recalculated",
  request_sent: "Supplier request",
  call_outcome: "Supplier call",
  offer_verified: "Supplier offer verified",
  approval: "Owner decision",
  execution: "Recovery execution",
  receipt: "Delivery receipt",
  control: "Case control",
};

const statusLabels: Record<TimelineEntry["status"], string> = {
  intended: "Intended",
  submitted: "Submitted",
  confirmed: "Confirmed",
  failed: "Failed",
  unknown: "Unknown",
  info: "Recorded",
};

function severityTone(severity: string): "danger" | "warning" | "neutral" {
  if (severity === "critical" || severity === "urgent") return "danger";
  if (severity === "warning") return "warning";
  return "neutral";
}

function quantityLabel(value: number | null, unit: string): string {
  return formatQuantity(value, unit) ?? "Unknown";
}

function moneyLabel(value: string | null, currency: string | null): string {
  return formatMoney(value, currency ?? "USD") ?? "Unknown";
}

function displayBalance(value: number, unit: string): string {
  const formatted = formatQuantity(Math.abs(value), unit) ?? "Unknown";
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

  return (
    <section aria-labelledby={chartId} className={styles.projection}>
      <figure>
        <figcaption id={chartId}>Projected usable stock</figcaption>
        <p className={styles.chartSummary}>
          {points.length
            ? `Projected balance ranges from ${displayBalance(minBalance, unit)} to ${displayBalance(maxBalance, unit)}.`
            : "Projection points are Unknown."}
        </p>
        <svg
          aria-labelledby={chartId}
          className={styles.chart}
          height={height}
          role="img"
          viewBox={`0 0 ${width} ${height}`}
        >
          <g aria-hidden="true">
            <line className={styles.zeroLine} x1={padding} x2={width - padding} y1={zeroY} y2={zeroY} />
            {linePoints && <polyline className={styles.projectionLine} points={linePoints} />}
            {firstShort && <circle className={styles.shortageMark} cx={firstShort.x} cy={firstShort.y} r="6" />}
          </g>
        </svg>
      </figure>
      <div className={styles.tableWrap}>
        <table>
          <caption>Projected usable stock ({unit}, {detail.case.location.timezone})</caption>
          <thead><tr><th scope="col">Time</th><th scope="col">Event</th><th scope="col">Change</th><th scope="col">Projected balance</th></tr></thead>
          <tbody>
            {points.length ? points.map((point, index) => (
              <tr key={`${point.at}-${index}`}>
                <td>{formatDateTime(point.at, detail.case.location.timezone) ?? "Unknown"}</td>
                <td>{point.label || point.kind}</td>
                <td>{formatQuantity(point.delta, unit) ?? "Unknown"}</td>
                <td>{displayBalance(point.balance, unit)}</td>
              </tr>
            )) : <tr><td colSpan={4}>Unknown</td></tr>}
          </tbody>
        </table>
      </div>
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
  return (
    <section aria-labelledby="impact-summary-heading" className={styles.impactSummary}>
      <h2 id="impact-summary-heading">Impact summary</h2>
      <dl className={styles.factList}>
        <div><dt>Shortage quantity</dt><dd>{quantityLabel(assessment?.bridge_quantity ?? null, detail.case.item.unit)} {sourceLink(source, detail.case.location.timezone)}</dd></div>
        <div><dt>First shortage</dt><dd>{formatDateTime(assessment?.first_shortage_at ?? null, detail.case.location.timezone) ?? "Unknown"} {sourceLink(source, detail.case.location.timezone)}</dd></div>
        <div><dt>Assessment horizon</dt><dd>{assessment?.horizon_start && assessment.horizon_end
          ? `${formatDateTime(assessment.horizon_start, detail.case.location.timezone)} – ${formatDateTime(assessment.horizon_end, detail.case.location.timezone)}`
          : "Unknown"}</dd></div>
      </dl>
      <h3>Original and revised receipts</h3>
      {detail.order_lines.length ? (
        <ul className={styles.receipts}>
          {detail.order_lines.map((line) => (
            <li key={line.po_line_id}>
              <strong>{line.po} · line {line.line}</strong>
              <span>Original due: {formatDateTime(line.original_due_at, detail.case.location.timezone) ?? "Unknown"}</span>
              {line.revised_receipts.length ? line.revised_receipts.map((receipt) => (
                <span key={receipt.id}>
                  Revised: {quantityLabel(receipt.quantity, detail.case.item.unit)} · {formatDateTime(receipt.earliest_at, detail.case.location.timezone) ?? "Unknown"}
                  {receipt.latest_at ? `–${formatDateTime(receipt.latest_at, detail.case.location.timezone)}` : ""}
                  {sourceLink(evidence.find((entry) => entry.purpose.includes(receipt.id)) ?? source, detail.case.location.timezone)}
                </span>
              )) : <span>Revised receipt: Unknown</span>}
            </li>
          ))}
        </ul>
      ) : <p>Original and revised receipt details are Unknown.</p>}
      {assessment?.missing_facts.length ? (
        <div className={styles.missingFacts}>
          <h3>Missing facts</h3>
          <ul>{assessment.missing_facts.map((fact) => <li key={fact}>{fact}: Unknown</li>)}</ul>
        </div>
      ) : null}
      <StockProjection detail={detail} />
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
                  <div><h4>{option.supplier.name || "Unknown supplier"}</h4><StatusBadge tone={feasibility === "feasible" ? "success" : feasibility === "rejected" ? "danger" : "warning"}>{label}</StatusBadge></div>
                  <p>{option.item_sku || "Unknown item"} · {option.location ?? "Unknown location"}</p>
                </header>
                <dl className={styles.optionFacts}>
                  <div><dt>Purchasing status</dt><dd>{option.supplier.purchasing_status}</dd></div>
                  <div><dt>Specification status</dt><dd>{option.specification_status}</dd></div>
                  <div><dt>Quantity and schedule</dt><dd>{option.quantity === null ? "Unknown" : formatQuantity(option.quantity, detail.case.item.unit)}
                    {option.schedule.map((entry, index) => <span key={`${option.id}-schedule-${index}`}> · {formatQuantity(entry.quantity, detail.case.item.unit)} by {formatDateTime(entry.arrival_start, detail.case.location.timezone) ?? "Unknown"}{entry.arrival_end ? `–${formatDateTime(entry.arrival_end, detail.case.location.timezone)}` : ""}</span>)}
                  </dd></div>
                  <div><dt>Quote validity</dt><dd>{formatDateTime(option.valid_until, detail.case.location.timezone) ?? "Unknown"}</dd></div>
                  <div><dt>Latest order time</dt><dd>{formatDateTime(option.latest_order_at, detail.case.location.timezone) ?? "Unknown"}</dd></div>
                  <div><dt>Written confirmation</dt><dd>{option.written_confirmation ? "Yes" : "No"}</dd></div>
                  <div><dt>Original order treatment</dt><dd>{option.original_order_treatment.replaceAll("_", " ")}</dd></div>
                  <div><dt>Surplus</dt><dd>{quantityLabel(option.surplus_quantity, detail.case.item.unit)}</dd></div>
                </dl>
                {option.reasons.length > 0 && <div className={styles.reasons}><strong>Constraints and reasons</strong><ul>{option.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></div>}
                {option.missing_fields.length > 0 && <p className={styles.missingOption}>Missing: {option.missing_fields.join(", ")}</p>}
                <dl className={styles.costs}>
                  {costRows.map(([label, key]) => (
                    <div key={key}><dt>{label}</dt><dd>{moneyLabel(option.costs[key], option.currency)}</dd></div>
                  ))}
                </dl>
                <p className={styles.verified}>Last verified: {formatDateTime(option.last_verified_at, detail.case.location.timezone) ?? "Unknown"}</p>
                {[...new Set(option.evidence_ids)].map((evidenceId) => {
                  const source = evidence.find((entry) => entry.id === evidenceId);
                  return source ? <EvidenceDrawer evidence={source} key={evidenceId} timeZone={detail.case.location.timezone} /> : null;
                })}
                {detail.permissions.can_correct_quote && (
                  <QuoteCorrectionForm
                    evidenceOptions={option.evidence_ids.map((id) => {
                      const source = evidence.find((entry) => entry.id === id);
                      return { id, label: source?.source_type ?? id };
                    })}
                    expectedVersion={detail.case.row_version}
                    originalText={option.evidence_ids.map((id) => evidence.find((entry) => entry.id === id)?.supported_excerpt).filter(Boolean).join("\n\n")}
                    quoteId={option.quote_id}
                    timezone={detail.case.location.timezone}
                  />
                )}
              </article>
            ))}
          </section>
        );
      })}
    </section>
  );
}

function ActionTimeline({
  timeline,
  evidence,
  detail,
  environmentMode,
}: {
  timeline: TimelineEntry[];
  evidence: CaseEvidence[];
  detail: CaseDetail;
  environmentMode: "live" | "sandbox" | "replay";
}) {
  const callActions = timeline.filter((entry) => entry.group === "call_outcome");
  return (
    <>
      <section aria-labelledby="timeline-heading" className={styles.timeline}>
        <h2 id="timeline-heading">Action timeline</h2>
        {timeline.length ? (
          <ol>
            {timeline.map((entry) => {
              const status = entry.title.toLowerCase().includes("sending")
                ? "Sending"
                : entry.title.toLowerCase().includes("cancelled")
                  ? "Cancelled"
                  : statusLabels[entry.status];
              const tone = status === "Failed" ? "danger" : status === "Unknown" ? "warning" : "neutral";
              return (
                <li key={entry.id}>
                  <div className={styles.timelineHeading}>
                    <h3>{groupLabels[entry.group]}</h3>
                    <StatusBadge tone={tone}>{status}</StatusBadge>
                  </div>
                  <p>{entry.title}</p>
                  <dl>
                    <div><dt>Time</dt><dd>{formatDateTime(entry.at, detail.case.location.timezone) ?? "Unknown"}</dd></div>
                    <div><dt>Actor</dt><dd>{entry.actor.label}</dd></div>
                  </dl>
                  {environmentMode === "replay" && entry.action_ref && <StatusBadge>Replay</StatusBadge>}
                  {[...new Set(entry.evidence_ids)].map((id) => {
                    const source = evidence.find((item) => item.id === id);
                    return source ? <EvidenceDrawer evidence={source} key={id} timeZone={detail.case.location.timezone} /> : null;
                  })}
                </li>
              );
            })}
          </ol>
        ) : <p>No recorded actions for this case.</p>}
      </section>
      <section aria-labelledby="calls-heading" className={styles.calls}>
        <h2 id="calls-heading">Supplier call</h2>
        {callActions.length ? (
          <ul>{callActions.map((call) => <li key={call.id}>{call.title} · {call.actor.label} · {statusLabels[call.status]}</li>)}</ul>
        ) : <p>No calls for this case.</p>}
        {callActions.length > 0 && environmentMode === "replay" && (
          <>
            <p>Replay mode: calls are simulated; no real call will be placed.</p>
            <button disabled type="button">Start call</button>
          </>
        )}
        {callActions.length > 0 && environmentMode !== "replay" && (
          <button aria-describedby="call-unavailable" disabled type="button">Start call</button>
        )}
        {callActions.length > 0 && environmentMode !== "replay" && <p id="call-unavailable">Calling isn’t available in this build yet.</p>}
      </section>
    </>
  );
}

export function CaseDetailView({
  detail,
  options,
  evidence,
  timeline,
  role,
  environmentMode,
}: {
  detail: CaseDetail;
  options: OptionRow[];
  evidence: CaseEvidence[];
  timeline: TimelineEntry[];
  role: "owner" | "operator" | "viewer";
  environmentMode: "live" | "sandbox" | "replay";
}) {
  const supportEvidence = evidence.find((item) => /delay|supplier|quote/i.test(item.purpose));
  const planOption = options.find((option) => option.plan_id === detail.plan?.plan_id);
  const planEvidence = detail.plan?.evidence_ids
    .map((id) => evidence.find((item) => item.id === id))
    .filter((item): item is CaseEvidence => item !== undefined) ?? [];
  const specification = detail.case.item.specification;
  return (
    <div className={styles.detail}>
      <header className={styles.caseHeader}>
        <p className={styles.eyebrow}>Case {detail.case.id}</p>
        <h1>{detail.case.title}</h1>
        <p>{detail.case.item.description || "Unknown item description"} · {detail.case.item.sku || "Unknown SKU"}</p>
        <p>Specification: {specification ? Object.entries(specification).map(([key, value]) => `${key}: ${String(value)}`).join(" · ") : "Unknown"}</p>
        <p>Location: {detail.case.location.name || "Unknown"}</p>
        <p>Purchase orders: {detail.case.purchase_orders.length ? detail.case.purchase_orders.join(", ") : "Unknown"}</p>
        <p>Assignee: {detail.case.assignee?.email ?? "Unassigned"}</p>
        <div className={styles.headerBadges}>
          <StatusBadge>{phaseLabels[detail.case.phase] ?? detail.case.phase}</StatusBadge>
          <StatusBadge tone={detail.case.run_control === "blocked" ? "warning" : "neutral"}>
            {detail.case.run_control}{detail.case.block_reason ? ` · ${detail.case.block_reason.replaceAll("_", " ")}` : ""}
          </StatusBadge>
          <StatusBadge tone={severityTone(detail.case.severity)}>{detail.case.severity.replaceAll("_", " ")}</StatusBadge>
          <StatusBadge>{detail.data_label ?? "Unknown"}</StatusBadge>
          {detail.case.data_stale && <StatusBadge tone="warning">Data stale</StatusBadge>}
        </div>
        <p className={styles.sourceTimes}>
          Source data as of {formatDateTime(detail.case.source_as_of, detail.case.location.timezone) ?? "Unknown"}
          {" · "}
          Assessed {formatDateTime(detail.assessment?.assessed_at ?? null, detail.case.location.timezone) ?? "Unknown"}
        </p>
      </header>
      <section aria-label="Case impact" className={styles.impact}>
        <h2>{detail.impact_sentence}</h2>
        <p>{detail.explanation}</p>
        {supportEvidence && <EvidenceDrawer evidence={supportEvidence} label="View impact source" timeZone={detail.case.location.timezone} />}
      </section>
      <aside aria-label="Decision panel" className={styles.decision}>
        <div className={styles.nextAction}>
          <p className={styles.eyebrow}>Next action</p>
          <h2>{detail.case.next_action.label}</h2>
          <p>Due: {formatDateTime(detail.case.next_action.due_at, detail.case.location.timezone) ?? "Unknown"}</p>
        </div>
        {detail.plan ? (
          <ApprovalCard
            canApprove={detail.permissions.can_approve}
            caseSummary={detail.case}
            environmentMode={environmentMode}
            originalOrderTreatment={planOption?.original_order_treatment ?? "Unknown"}
            plan={detail.plan}
            role={role}
          />
        ) : <p>No recovery plan is awaiting approval.</p>}
        <CaseControls detail={detail} role={role} />
      </aside>
      <ImpactSummary detail={detail} evidence={evidence} />
      <SupplierOptionTable detail={detail} evidence={evidence} options={options} />
      <ActionTimeline detail={detail} environmentMode={environmentMode} evidence={evidence} timeline={timeline} />
      <section aria-labelledby="evidence-heading" className={styles.evidenceList}>
        <h2 id="evidence-heading">Evidence</h2>
        {evidence.length ? (
          <ul>
            {evidence.map((entry) => (
              <li key={`${entry.id}:${entry.purpose}`}>
                <strong>{entry.source_type || "Unknown source"}</strong>
                <span>{entry.purpose.replaceAll("_", " ")}</span>
                <span>{formatDateTime(entry.source_time, detail.case.location.timezone) ?? "Unknown"}</span>
                <EvidenceDrawer evidence={entry} timeZone={detail.case.location.timezone} />
              </li>
            ))}
          </ul>
        ) : <p>No evidence is linked to this case.</p>}
        {planEvidence.length > 0 && <p>{planEvidence.length} source{planEvidence.length === 1 ? "" : "s"} support the current plan.</p>}
      </section>
    </div>
  );
}
