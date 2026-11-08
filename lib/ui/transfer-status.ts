export type TransferTone = "info" | "success" | "warning" | "danger" | "neutral";

export interface TransferActionLike {
  state: string;
  error_code: string | null;
  summary: string | null;
  provider: string | null;
  provider_ref: string | null;
}

export interface TransferStatusView {
  tone: TransferTone;
  label: string;
  detail: string;
  /** Conduit is still writing or waiting on a readback. */
  inFlight: boolean;
  /** A readback from the business system backs this state. */
  evidence: { summary: string; reference: string | null } | null;
}

const providerName: Record<string, string> = {
  shopify: "Shopify",
  odoo: "Odoo",
  zoho_inventory: "Zoho Inventory",
  quickbooks: "QuickBooks Online",
};

/** What the owner sees for a stock transfer's action: in flight, confirmed with evidence, or needing a check. */
export function describeTransferAction(action: TransferActionLike): TransferStatusView {
  const system = (action.provider && providerName[action.provider]) || "the business system";
  const evidence = action.summary ? { summary: action.summary, reference: action.provider_ref } : null;
  switch (action.state) {
    case "prepared":
    case "dispatching":
    case "submitted":
      return {
        tone: "info",
        label: "In flight",
        detail: `Conduit is creating the transfer in ${system}. It is not confirmed until ${system} shows it.`,
        inFlight: true,
        evidence: null,
      };
    case "unknown":
      return {
        tone: "warning",
        label: "Outcome unknown",
        detail: `Conduit could not confirm the transfer in ${system} and will not send it again. It checks ${system} on a schedule; you can also confirm it there and record evidence.`,
        inFlight: false,
        evidence,
      };
    case "confirmed":
      return {
        tone: "success",
        label: "Confirmed",
        detail: `${system} shows the stock reserved and dispatched. This records the transfer; the goods count as received only once ${system} shows them received.`,
        inFlight: false,
        evidence,
      };
    case "failed":
      return {
        tone: "danger",
        label: "Not executed",
        detail:
          action.error_code === "source_stock_changed" || action.error_code === "source_stock_unavailable"
            ? "The source location's stock changed after approval, so nothing was moved. Review the case for an updated plan."
            : `Nothing was moved. ${action.summary ?? "The business system did not accept the transfer."}`,
        inFlight: false,
        evidence,
      };
    case "cancelled":
      return { tone: "neutral", label: "Cancelled", detail: "The transfer was cancelled before it was sent.", inFlight: false, evidence: null };
    default:
      return { tone: "neutral", label: action.state, detail: "", inFlight: false, evidence };
  }
}
