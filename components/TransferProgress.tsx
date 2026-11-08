import type { PlanActionView } from "@/lib/db/queries/cases";
import { describeTransferAction } from "@/lib/ui/transfer-status";
import { StatusBadge } from "./StatusBadge";
import styles from "./transfer.module.css";

/** In-flight and confirmed states of a plan's stock transfer, with the business system's own readback as evidence. */
export function TransferProgress({ actions }: { actions: PlanActionView[] }) {
  const transfers = actions.filter((action) => action.kind === "live_business_transfer");
  if (transfers.length === 0) return null;
  return (
    <section aria-labelledby="transfer-progress-title" className={styles.progress}>
      <h3 id="transfer-progress-title">Stock transfer</h3>
      {transfers.map((action) => {
        const view = describeTransferAction(action);
        return (
          <div className={styles.progressItem} key={action.id}>
            <StatusBadge tone={view.tone}>{view.label}</StatusBadge>
            <p>{view.detail}</p>
            {view.evidence && (
              <dl className={styles.evidence}>
                <div><dt>Evidence</dt><dd>{view.evidence.summary}</dd></div>
                {view.evidence.reference && <div><dt>Reference</dt><dd>{view.evidence.reference}</dd></div>}
              </dl>
            )}
          </div>
        );
      })}
    </section>
  );
}
