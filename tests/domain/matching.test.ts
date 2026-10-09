import { describe, expect, it } from "vitest";
import {
  matchDelay,
  normalizeOrderRef,
  type MatchContext,
  type ContextLine,
} from "@/lib/domain/matching";
import type { VerifiedLine } from "@/lib/agent/extraction-verify";

const line = (over: Partial<ContextLine>): ContextLine => ({
  po_line_id: "l1",
  po_id: "po1",
  po_external_id: "PO-1042",
  external_line_id: "1",
  supplier_id: "s1",
  item_id: "i1",
  sku: "CARTON-302015",
  base_unit: "carton",
  supplier_skus: [],
  location_id: "loc1",
  location_timezone: "America/Los_Angeles",
  ordered_qty: 4000,
  received_qty: 0,
  cancelled_qty: 0,
  active_schedules: [
    {
      id: "sch1",
      quantity_remaining: 4000,
      earliest_at: "2026-10-13T15:00:00Z",
      latest_at: "2026-10-13T15:00:00Z",
      promise_state: "confirmed",
    },
  ],
  ...over,
});

const context = (lines: ContextLine[]): MatchContext => ({
  sender_contacts: [
    {
      contact_id: "c1",
      supplier_id: "s1",
      supplier_name: "Bay",
      normalized_address: "alyssa@baycarton.example.com",
      channel: "email",
      outreach_approved_at: "2026-01-01T00:00:00Z",
      permitted_channels: ["email"],
    },
  ],
  lines,
});

const vline = (over: Partial<VerifiedLine>): VerifiedLine => ({
  line_index: 0,
  order_ref: "PO-1042",
  line_ref: null,
  item_ref: null,
  affected_quantity: null,
  quantity_scope: "all_remaining",
  unit: "carton",
  new_promise: {
    earliest_at: "2026-10-16T15:00:00.000Z",
    latest_at: "2026-10-16T15:00:00.000Z",
    promise_state: "confirmed",
    date_only: false,
  },
  body_evidence_id: "ev1",
  ...over,
});

const args = (ctx: MatchContext, vls: VerifiedLine[]) => ({
  senderAddress: "alyssa@baycarton.example.com",
  verifiedLines: vls,
  context: ctx,
  isDelayNotice: true,
});

describe("matching", () => {
  it("matches a full delay and emits a MatchedLine", () => {
    const out = matchDelay(args(context([line({})]), [vline({})]));
    expect(out.status).toBe("matched");
    expect(out.lines[0]).toMatchObject({
      affected_qty: 4000,
      remaining_qty: 4000,
      full: true,
      new_promise_state: "confirmed",
    });
  });

  it("rejects unit mismatch", () => {
    const out = matchDelay(
      args(context([line({})]), [vline({ unit: "pallet" })]),
    );
    expect(out.status).toBe("needs_review");
    expect(out.unresolved.some((u) => u.field === "unit")).toBe(true);
  });

  it("rejects quantity above remaining", () => {
    const out = matchDelay(
      args(
        context([line({})]),
        [vline({ quantity_scope: "partial", affected_quantity: 5000 })],
      ),
    );
    expect(out.status).toBe("needs_review");
    expect(out.unresolved[0].reason).toBe("quantity");
  });

  it("flags multiple active schedules", () => {
    const ctx = context([
      line({
        active_schedules: [
          {
            id: "s1",
            quantity_remaining: 2000,
            earliest_at: null,
            latest_at: null,
            promise_state: "confirmed",
          },
          {
            id: "s2",
            quantity_remaining: 2000,
            earliest_at: null,
            latest_at: null,
            promise_state: "estimated",
          },
        ],
      }),
    ]);
    const out = matchDelay(args(ctx, [vline({})]));
    expect(out.status).toBe("needs_review");
    expect(out.unresolved.some((u) => u.field === "schedule")).toBe(true);
  });

  it("normalizes PO reference variants", () => {
    expect(normalizeOrderRef("PO-1042")).toBe("1042");
    expect(normalizeOrderRef("PO 1042")).toBe("1042");
    expect(normalizeOrderRef("#1042")).toBe("1042");
    const out = matchDelay(
      args(context([line({})]), [vline({ order_ref: "#1042" })]),
    );
    expect(out.status).toBe("matched");
  });

  it("ambiguous order lines produce candidates", () => {
    const ctx = context([
      line({ po_line_id: "a", po_external_id: "PO-1042" }),
      line({ po_line_id: "b", po_external_id: "PO-1044" }),
    ]);
    const out = matchDelay(args(ctx, [vline({ order_ref: null })]));
    expect(out.status).toBe("needs_review");
    expect(out.unresolved.some((u) => u.field === "order_line")).toBe(true);
    expect(out.candidates.map((c) => c.po_external_id).sort()).toEqual([
      "PO-1042",
      "PO-1044",
    ]);
  });

  it("unknown sender is unresolved supplier, not matched", () => {
    const out = matchDelay({
      senderAddress: "attacker@evil.example",
      verifiedLines: [vline({})],
      context: context([line({})]),
      isDelayNotice: true,
    });
    expect(out.status).toBe("needs_review");
    expect(out.unresolved.some((u) => u.field === "supplier")).toBe(true);
    expect(out.lines).toHaveLength(0);
  });

  it("not a delay notice returns not_delay", () => {
    const out = matchDelay({
      senderAddress: "alyssa@baycarton.example.com",
      verifiedLines: [vline({})],
      context: context([line({})]),
      isDelayNotice: false,
    });
    expect(out.status).toBe("not_delay");
  });

  it("pins select the pinned po_line during resolution", () => {
    const ctx = context([
      line({ po_line_id: "a", po_external_id: "PO-1042" }),
      line({ po_line_id: "b", po_external_id: "PO-1044" }),
    ]);
    const out = matchDelay({
      ...args(ctx, [vline({ order_ref: null })]),
      pins: { 0: "b" },
    });
    expect(out.status).toBe("matched");
    expect(out.lines[0].po_line_id).toBe("b");
  });

  it("contains no numeric confidence anywhere in output", () => {
    const out = matchDelay(args(context([line({})]), [vline({})]));
    expect(JSON.stringify(out)).not.toMatch(/confidence/i);
  });
});
