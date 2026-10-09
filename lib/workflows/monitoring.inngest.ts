import { monitorPoLineDelivery } from "@/lib/actions/receipts";
import { serverLedger } from "@/lib/actions/server";
import { inngest } from "./client";
import { consumeOnce } from "./outbox";

/** Closes monitored cases as delivered only when receiving events cover every open line. */
export const monitorReceipts = inngest.createFunction(
  { id: "monitoring-receipt-recorded", triggers: [{ event: "receipt.recorded" }] },
  async ({ event, step }) => {
    const data = event.data as Record<string, string>;
    const fresh = await step.run("dedupe", () =>
      consumeOnce(serverLedger().rpc, "monitoring.receipt_recorded", data.org_id, data.event_id),
    );
    if (!fresh) return { status: "duplicate" };
    return step.run("check-delivery", () => monitorPoLineDelivery(serverLedger(), data.org_id, data.po_line_id));
  },
);
