import { describe, expect, it } from "vitest";
import type { ExtractionV1 } from "@/lib/agent/extraction-schema";
import {
  verifyOfferTerms,
  type VerifyResult,
} from "@/lib/agent/extraction-verify";
import { buildResponseQuotes } from "@/lib/domain/supplier-response";

const facts = (over: Partial<ExtractionV1>): ExtractionV1 => ({
  schema_version: 1,
  is_delay_notice: false,
  lines: [],
  offer: null,
  notes_for_reviewer: "",
  ...over,
});

const verifyResult = (lines: VerifyResult["lines"]): VerifyResult => ({
  lines,
  unresolved: [],
});

const line = (over: Partial<VerifyResult["lines"][number]>) => ({
  line_index: 0,
  order_ref: "PO-1042",
  line_ref: null,
  item_ref: "CARTON-302015",
  affected_quantity: null,
  quantity_scope: "partial" as const,
  unit: "carton",
  new_promise: null,
  ...over,
});

const sentAt = new Date("2026-10-12T17:00:00Z");
const tz = "America/Los_Angeles";

describe("verifyOfferTerms", () => {
  it("resolves a quoted end-date to end of day in the org timezone", () => {
    const out = verifyOfferTerms(
      {
        unit_price_minor: null,
        currency: "USD",
        freight_minor: 7500,
        fees_minor: null,
        valid_until: {
          quote: "valid until Thursday, October 15",
          local_date: "2026-10-15",
          local_time: null,
        },
        order_cutoff: null,
      },
      "This offer is valid until Thursday, October 15.",
      sentAt,
      tz,
      tz,
    );
    expect(out.valid_until).toBe("2026-10-16T06:59:59.999Z");
    expect(out.latest_order_at).toBeNull();
  });

  it("drops terms whose quote is absent from the body or not an explicit date", () => {
    const offer = {
      unit_price_minor: null,
      currency: null,
      freight_minor: null,
      fees_minor: null,
      valid_until: {
        quote: "valid until the end of the universe",
        local_date: "2026-10-15",
        local_time: null,
      },
      order_cutoff: {
        quote: "by Wednesday",
        local_date: "2026-10-14",
        local_time: null,
      },
    };
    const out = verifyOfferTerms(offer, "No such words appear here.", sentAt, tz, tz);
    expect(out.valid_until).toBeNull();
    // A bare weekday is not an explicit calendar date even if quoted.
    const body = verifyOfferTerms(offer, "order by Wednesday", sentAt, tz, tz);
    expect(body.latest_order_at).toBeNull();
  });
});

describe("buildResponseQuotes", () => {
  it("emits one quote per verified line that carries terms", () => {
    const quotes = buildResponseQuotes(
      facts({
        offer: {
          unit_price_minor: null,
          currency: "USD",
          freight_minor: 7500,
          fees_minor: null,
          valid_until: null,
          order_cutoff: null,
        },
      }),
      verifyResult([
        line({
          affected_quantity: 600,
          new_promise: {
            earliest_at: "2026-10-14T07:00:00.000Z",
            latest_at: "2026-10-15T06:59:59.999Z",
            promise_state: "confirmed",
            date_only: true,
          },
        }),
        line({
          line_index: 1,
          affected_quantity: 3400,
          new_promise: {
            earliest_at: "2026-10-16T07:00:00.000Z",
            latest_at: "2026-10-17T06:59:59.999Z",
            promise_state: "confirmed",
            date_only: true,
          },
        }),
      ]),
      { valid_until: "2026-10-16T06:59:59.999Z", latest_order_at: null },
    );
    expect(quotes).toHaveLength(2);
    expect(quotes[0]).toMatchObject({
      quantity: 600,
      freight_minor: 7500,
      currency: "USD",
      valid_until: "2026-10-16T06:59:59.999Z",
      arrival_start: "2026-10-14T07:00:00.000Z",
    });
    expect(quotes[1]).toMatchObject({ quantity: 3400 });
  });

  it("returns no quotes when the reply carries no usable terms", () => {
    const quotes = buildResponseQuotes(
      facts({}),
      verifyResult([line({})]),
      { valid_until: null, latest_order_at: null },
    );
    expect(quotes).toEqual([]);
  });

  it("records email-level terms alone as one quote when no line is usable", () => {
    const quotes = buildResponseQuotes(
      facts({
        offer: {
          unit_price_minor: 4200,
          currency: "USD",
          freight_minor: 6000,
          fees_minor: null,
          valid_until: null,
          order_cutoff: null,
        },
      }),
      verifyResult([]),
      { valid_until: null, latest_order_at: null },
    );
    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toMatchObject({
      quantity: null,
      arrival_end: null,
      unit_price_minor: 4200,
      freight_minor: 6000,
    });
  });
});
