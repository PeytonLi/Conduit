"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { parseMajorDecimal } from "@/lib/domain/money";
import type { TransferOptions as TransferOptionsData, TransferSourceOption } from "@/lib/db/queries/transfers";
import { formatQuantity } from "@/lib/db/queries/format";
import { localDateTimeToIso } from "@/lib/ui/zoned-time";
import { postJson, WorkspaceApiError, workspaceErrorMessage } from "./client-api";
import { LiveRegion } from "./LiveRegion";
import { StatusBadge } from "./StatusBadge";
import styles from "./transfer.module.css";

const providerLabels: Record<string, string> = {
  shopify: "Shopify",
  odoo: "Odoo",
  zoho_inventory: "Zoho Inventory",
  quickbooks: "QuickBooks Online",
};

function SourceCard({
  data,
  source,
  canCreate,
  hasCurrentPlan,
}: {
  data: TransferOptionsData;
  source: TransferSourceOption;
  canCreate: boolean;
  hasCurrentPlan: boolean;
}) {
  const router = useRouter();
  const intentKey = useRef<string | null>(null);
  const suggested = Math.min(source.max_safe_qty, data.shortage_qty ?? source.max_safe_qty);
  const [quantity, setQuantity] = useState(String(suggested));
  const [arrival, setArrival] = useState("");
  const [cost, setCost] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const executes = data.execution.mode === "execute";
  const unit = data.item.unit;
  const id = `transfer-${source.source_location_id}`;

  async function submit() {
    setError("");
    setMessage("");
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty <= 0) return setError("Enter a whole quantity above zero.");
    if (qty > source.max_safe_qty) {
      return setError(`${source.source_location_name} can spare at most ${formatQuantity(source.max_safe_qty, unit)} without running short itself.`);
    }
    const arrivesAt = localDateTimeToIso(arrival, data.destination.timezone);
    if (!arrivesAt) return setError("Enter when the stock is expected to arrive. Unknown timing leaves the option incomplete.");
    let costMinor: string;
    try {
      costMinor = parseMajorDecimal(cost.trim() || "0", data.currency).toString();
    } catch {
      return setError("Enter the handling cost as an amount such as 25.00, or 0 if there is none.");
    }
    if (!data.assessment_id) return setError("This case has no current assessment yet.");
    intentKey.current ??= crypto.randomUUID();
    setSubmitting(true);
    try {
      await postJson(
        `/api/v1/cases/${data.case_id}/plans`,
        {
          assessment_id: data.assessment_id,
          steps: [
            {
              step_id: "transfer-1",
              kind: "transfer_stock",
              item_id: data.item.id,
              unit,
              quantity: qty,
              destination_location_id: data.destination.id,
              execution_mode: executes ? "live_connector" : "manual",
              payload: {
                source_location_id: source.source_location_id,
                arrival_end: arrivesAt,
                transfer_cost_minor: costMinor,
                summary: `Move ${qty} ${unit} from ${source.source_location_name} to ${data.destination.name}`,
              },
            },
          ],
        },
        intentKey.current,
      );
      intentKey.current = null;
      setMessage("Transfer plan created. Review and approve it in the decision panel.");
      router.refresh();
    } catch (submitError) {
      intentKey.current = null;
      if (submitError instanceof WorkspaceApiError && submitError.code === "validation_failed") {
        setError("The source can't spare that quantity, or a term is incomplete. Check the quantity, arrival time and cost.");
      } else if (submitError instanceof WorkspaceApiError && submitError.code === "unsupported_step") {
        setError("The business system can't run this transfer right now. Refresh to see why.");
      } else {
        setError(workspaceErrorMessage(submitError));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <article aria-labelledby={`${id}-name`} className={styles.source}>
      <header>
        <h4 id={`${id}-name`}>{source.source_location_name}</h4>
        <StatusBadge tone={source.max_safe_qty > 0 ? "success" : "neutral"}>
          {source.max_safe_qty > 0 ? "Can spare stock" : "No spare stock"}
        </StatusBadge>
      </header>
      <dl className={styles.facts}>
        <div><dt>On hand</dt><dd>{formatQuantity(source.physical_qty, unit)}</dd></div>
        <div><dt>Can spare</dt><dd>{formatQuantity(source.max_safe_qty, unit)} without a shortage there</dd></div>
        {data.shortage_qty !== null && <div><dt>Shortage here</dt><dd>{formatQuantity(data.shortage_qty, unit)}</dd></div>}
      </dl>
      {source.max_safe_qty > 0 && canCreate && (
        <div className={styles.form}>
          <label>
            Quantity
            <input inputMode="numeric" onChange={(event) => { intentKey.current = null; setQuantity(event.target.value); }} value={quantity} />
          </label>
          <label>
            Expected arrival ({data.destination.timezone})
            <input onChange={(event) => { intentKey.current = null; setArrival(event.target.value); }} type="datetime-local" value={arrival} />
          </label>
          <label>
            Handling cost ({data.currency})
            <input inputMode="decimal" onChange={(event) => { intentKey.current = null; setCost(event.target.value); }} placeholder="0.00" value={cost} />
          </label>
          {hasCurrentPlan && <p className={styles.full}>Creating this plan replaces the case&rsquo;s current plan and any approval on it.</p>}
          {error && <p className={`${styles.error} ${styles.full}`} role="alert">{error}</p>}
          <button className={styles.submit} disabled={submitting} onClick={() => void submit()} type="button">
            {submitting ? "Creating plan…" : executes ? "Create transfer plan" : "Create recommendation plan"}
          </button>
          {message && <p className={`${styles.result} ${styles.full}`}>{message}</p>}
          <LiveRegion message={message || error} />
        </div>
      )}
    </article>
  );
}

/** Internal transfer options for a case. Quantities are computed by code; the owner still approves every transfer. */
export function TransferOptions({
  data,
  canCreate,
  hasCurrentPlan,
}: {
  data: TransferOptionsData;
  canCreate: boolean;
  hasCurrentPlan: boolean;
}) {
  const provider = data.execution.provider ? providerLabels[data.execution.provider] ?? data.execution.provider : null;
  return (
    <section aria-labelledby="transfer-options-heading" className={styles.options}>
      <h3 id="transfer-options-heading">Internal stock transfer</h3>
      <p className={styles.mode}>
        {data.execution.mode === "execute"
          ? `After owner approval, Conduit reserves and dispatches the transfer in ${provider ?? "your business system"} and confirms it from what the system shows.`
          : `Recommendation only. Conduit will not move this stock${provider ? ` in ${provider}` : ""}: ${data.execution.reason ?? "execution is not available"} The approved plan exports as a manual packet.`}
      </p>
      {data.sources.length === 0 ? (
        <p>No other location holds this item in the current business data.</p>
      ) : (
        data.sources.map((source) => (
          <SourceCard canCreate={canCreate} data={data} hasCurrentPlan={hasCurrentPlan} key={source.source_location_id} source={source} />
        ))
      )}
    </section>
  );
}
