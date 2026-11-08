import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ApprovalCard } from "@/components/ApprovalCard";
import { TransferOptions } from "@/components/TransferOptions";
import { TransferProgress } from "@/components/TransferProgress";
import type { ApprovalView, PlanActionView } from "@/lib/db/queries/cases";
import type { TransferOptions as TransferOptionsData } from "@/lib/db/queries/transfers";
import { describeTransferAction } from "@/lib/ui/transfer-status";
import { localDateTimeToIso } from "@/lib/ui/zoned-time";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const action = (overrides: Partial<PlanActionView> = {}): PlanActionView => ({
  id: "a1",
  kind: "live_business_transfer",
  state: "confirmed",
  plan_step_id: "transfer-1",
  provider: "shopify",
  provider_ref: "gid://shopify/InventoryTransfer/1#CDT-abc",
  error_code: null,
  summary: "shopify shows the transfer: 50 units dispatched and in transit",
  updated_at: "2030-01-10T12:00:00Z",
  ...overrides,
});

describe("transfer status", () => {
  it("shows in-flight work as unconfirmed, with no evidence yet", () => {
    for (const state of ["prepared", "dispatching", "submitted"]) {
      const view = describeTransferAction(action({ state, summary: null }));
      expect(view).toMatchObject({ label: "In flight", inFlight: true, evidence: null });
      expect(view.detail).toContain("not confirmed until Shopify shows it");
    }
  });

  it("shows a confirmed transfer with the readback as evidence, and does not call it received", () => {
    const view = describeTransferAction(action());
    expect(view).toMatchObject({ tone: "success", label: "Confirmed", inFlight: false });
    expect(view.evidence).toEqual({ summary: action().summary, reference: action().provider_ref });
    expect(view.detail).toContain("only once Shopify shows them received");
  });

  it("says Conduit will not retry an unknown outcome", () => {
    const view = describeTransferAction(action({ state: "unknown" }));
    expect(view).toMatchObject({ tone: "warning", label: "Outcome unknown" });
    expect(view.detail).toContain("will not send it again");
  });

  it("explains a stale-stock failure as nothing moved", () => {
    const view = describeTransferAction(action({ state: "failed", error_code: "source_stock_changed" }));
    expect(view.tone).toBe("danger");
    expect(view.detail).toContain("nothing was moved");
  });

  it("covers cancelled and unfamiliar states", () => {
    expect(describeTransferAction(action({ state: "cancelled" })).label).toBe("Cancelled");
    expect(describeTransferAction(action({ state: "mystery" })).label).toBe("mystery");
  });
});

describe("TransferProgress", () => {
  it("renders nothing without a transfer action", () => {
    expect(renderToStaticMarkup(createElement(TransferProgress, { actions: [action({ kind: "demo_ledger_amendment" })] }))).toBe("");
  });

  it("renders the confirmed state with its evidence and reference", () => {
    const html = renderToStaticMarkup(createElement(TransferProgress, { actions: [action()] }));
    expect(html).toContain("Stock transfer");
    expect(html).toContain("Confirmed");
    expect(html).toContain("50 units dispatched and in transit");
    expect(html).toContain("gid://shopify/InventoryTransfer/1#CDT-abc");
  });

  it("renders in-flight without evidence", () => {
    const html = renderToStaticMarkup(createElement(TransferProgress, { actions: [action({ state: "dispatching", summary: null, provider_ref: null })] }));
    expect(html).toContain("In flight");
    expect(html).not.toContain("Evidence");
  });
});

const optionsData = (overrides: Partial<TransferOptionsData> = {}): TransferOptionsData => ({
  case_id: "case-1",
  assessment_id: "assessment-1",
  item: { id: "item-1", sku: "BOLT", unit: "each" },
  destination: { id: "dest-1", name: "Main warehouse", timezone: "America/Los_Angeles" },
  shortage_qty: 600,
  currency: "USD",
  execution: { mode: "execute", provider: "shopify", code: null, reason: null },
  sources: [{ source_location_id: "src-1", source_location_name: "Overflow warehouse", physical_qty: 500, max_safe_qty: 50 }],
  ...overrides,
});

describe("TransferOptions", () => {
  it("shows the spare quantity and says execution follows owner approval", () => {
    const html = renderToStaticMarkup(createElement(TransferOptions, { data: optionsData(), canCreate: true, hasCurrentPlan: false }));
    expect(html).toContain("Overflow warehouse");
    expect(html).toContain("without a shortage there");
    expect(html).toContain("After owner approval, Conduit reserves and dispatches the transfer in Shopify");
    expect(html).toContain("Create transfer plan");
    expect(html).toContain("America/Los_Angeles");
  });

  it("is honest that a recommend-only connector will not move stock, and why", () => {
    const html = renderToStaticMarkup(
      createElement(TransferOptions, {
        data: optionsData({ execution: { mode: "recommend_only", provider: "odoo", code: "provider_unsupported", reason: "The Odoo connector does not create internal transfers." } }),
        canCreate: true,
        hasCurrentPlan: true,
      }),
    );
    expect(html).toContain("Recommendation only. Conduit will not move this stock in Odoo");
    expect(html).toContain("The Odoo connector does not create internal transfers.");
    expect(html).toContain("Create recommendation plan");
    expect(html).toContain("replaces the case");
    expect(html).not.toContain("Create transfer plan");
  });

  it("hides the form from viewers and for sources with no spare stock", () => {
    const viewer = renderToStaticMarkup(createElement(TransferOptions, { data: optionsData(), canCreate: false, hasCurrentPlan: false }));
    expect(viewer).not.toContain("Create transfer plan");
    const none = renderToStaticMarkup(
      createElement(TransferOptions, {
        data: optionsData({ sources: [{ source_location_id: "s", source_location_name: "Closed store", physical_qty: 10, max_safe_qty: 0 }] }),
        canCreate: true,
        hasCurrentPlan: false,
      }),
    );
    expect(none).toContain("No spare stock");
    expect(none).not.toContain("Create transfer plan");
  });
});

describe("ApprovalCard for a transfer plan", () => {
  const plan = (overrides: Partial<ApprovalView> = {}): ApprovalView => ({
    plan_id: "plan-1",
    plan_version: 2,
    status: "approved",
    row_version: 3,
    input_fingerprint: "fp",
    gross_commitment_minor: "2500",
    incremental_cost_minor: "2500",
    currency: "USD",
    approved_ceiling_minor: "2500",
    expires_at: null,
    dependencies: [],
    steps: [
      {
        step_id: "transfer-1",
        kind: "transfer_stock",
        quantity: 50,
        unit: "each",
        summary: "Move 50 each from Overflow warehouse to Main warehouse",
        execution_mode: "live_connector",
        transfer: {
          source_location_id: "src-1",
          source_location_name: "Overflow warehouse",
          arrival_start: null,
          arrival_end: "2030-01-12T17:00:00.000Z",
          cost_minor: "2500",
          source_coverage_evidence_id: null,
          missing_fields: [],
        },
      },
    ],
    plan_actions: [action({ state: "dispatching", summary: null, provider_ref: null })],
    supplier: null,
    evidence_ids: [],
    approver_required: "owner",
    ...overrides,
  });
  const caseSummary = { id: "case-1", row_version: 1, clock_now: "2030-01-10T12:00:00Z", data_label: "Live", location: { timezone: "America/Los_Angeles" } } as never;
  const render = (p: ApprovalView) =>
    renderToStaticMarkup(createElement(ApprovalCard, { plan: p, caseSummary, canApprove: true, role: "owner", environmentMode: "live", originalOrderTreatment: "" }));

  it("shows source, arrival, cost, execution mode and the in-flight state", () => {
    const html = render(plan());
    expect(html).toContain("Stock source");
    expect(html).not.toContain("Supplier details unavailable");
    expect(html).toContain("From Overflow warehouse");
    expect(html).toContain("USD 25.00");
    expect(html).toContain("Conduit moves the stock in your business system after approval");
    expect(html).toContain("In flight");
  });

  it("labels a manual transfer as a recommendation Conduit will not execute", () => {
    const html = render(plan({ steps: [{ ...plan().steps[0], execution_mode: "manual" }], plan_actions: [] }));
    expect(html).toContain("Recommendation only: you move the stock; Conduit does not");
    expect(html).not.toContain("Stock transfer</h3>");
  });
});

describe("localDateTimeToIso", () => {
  it("reads the wall time in the location's zone", () => {
    expect(localDateTimeToIso("2030-01-12T09:00", "America/Los_Angeles")).toBe("2030-01-12T17:00:00.000Z");
    expect(localDateTimeToIso("2030-07-12T09:00", "America/Los_Angeles")).toBe("2030-07-12T16:00:00.000Z");
    expect(localDateTimeToIso("2030-01-12T09:00", "UTC")).toBe("2030-01-12T09:00:00.000Z");
    expect(localDateTimeToIso("2030-01-12T09:00", "Asia/Kolkata")).toBe("2030-01-12T03:30:00.000Z");
  });

  it("resolves a wall time skipped by a DST jump to just after the jump", () => {
    expect(localDateTimeToIso("2030-03-10T02:30", "America/Los_Angeles")).toBe("2030-03-10T10:30:00.000Z");
  });

  it("rejects malformed input and unknown zones", () => {
    expect(localDateTimeToIso("", "UTC")).toBeNull();
    expect(localDateTimeToIso("2030-01-12", "UTC")).toBeNull();
    expect(localDateTimeToIso("2030-01-12T09:00", "Not/AZone")).toBeNull();
  });
});
