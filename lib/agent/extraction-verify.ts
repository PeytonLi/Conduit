import type { ExtractionV1 } from "./extraction-schema";

export interface VerifySegment {
  kind: "body" | "quoted" | "forwarded";
  index: number;
  content: string;
  evidence_id?: string;
}

export interface UnresolvedFact {
  line_index: number;
  field: string;
  reason: string;
}

export interface VerifiedPromise {
  earliest_at: string; // ISO UTC
  latest_at: string; // ISO UTC
  promise_state: "confirmed" | "estimated";
  date_only: boolean;
}

export interface VerifiedLine {
  line_index: number;
  order_ref: string | null;
  line_ref: string | null;
  item_ref: string | null;
  affected_quantity: number | null;
  quantity_scope: "all_remaining" | "partial" | "unstated";
  unit: string | null;
  new_promise: VerifiedPromise | null;
  body_evidence_id?: string;
}

export interface VerifyResult {
  lines: VerifiedLine[];
  unresolved: UnresolvedFact[];
}

function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Locate a quote inside haystack (whitespace-normalized, case-insensitive). */
export function findQuote(haystack: string, quote: string): number {
  const hay = normalizeText(haystack);
  const needle = normalizeText(quote);
  if (!needle) return -1;
  return hay.indexOf(needle);
}

const MONTHS: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

const WEEKDAYS = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
const VAGUE = /\b(next week|next month|soon|later|asap|end of (the )?week)\b/i;

function resolveDateYear(month: number, day: number, sentAt: Date, timezone: string): number | null {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, year: "numeric", month: "numeric", day: "numeric",
    }).formatToParts(sentAt).map((p) => [p.type, p.value]),
  );
  const sentYear = Number(parts.year);
  const sentMonth = Number(parts.month) - 1;
  const sentDay = Number(parts.day);
  const sentDate = Date.UTC(sentYear, sentMonth, sentDay);
  const [lower, upper] = [-6, 6].map((offset) => {
    const bound = new Date(Date.UTC(sentYear, sentMonth + offset, 1));
    const lastDay = new Date(Date.UTC(bound.getUTCFullYear(), bound.getUTCMonth() + 1, 0)).getUTCDate();
    bound.setUTCDate(Math.min(sentDay, lastDay));
    return bound.getTime();
  });
  const candidates = [sentYear - 1, sentYear, sentYear + 1]
    .map((year) => new Date(Date.UTC(year, month - 1, day)))
    .filter((date) =>
      date.getUTCMonth() === month - 1 && date.getUTCDate() === day
      && date.getTime() >= lower && date.getTime() <= upper,
    )
    .sort((a, b) => Math.abs(a.getTime() - sentDate) - Math.abs(b.getTime() - sentDate));
  return candidates[0]?.getUTCFullYear() ?? null;
}

/**
 * A quote supports an explicit calendar date if it names a month (word or
 * numeric) plus the matching day and explicit or sent-date-resolved year.
 * A bare weekday or vague phrase is rejected.
 */
export function quoteSupportsDate(
  quote: string,
  localDate: string,
  sentAt: Date,
  timezone: string,
): "ok" | "date_not_explicit" | "date_mismatch" {
  const q = normalizeText(quote);
  const day = Number(localDate.slice(8, 10));

  // ISO / numeric forms in the quote
  const numeric = q.match(/\b(\d{1,4})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?\b/g) ?? [];
  const monthNamed = q.match(
    /\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:[,\s]+(\d{4})\b)?/,
  );
  const dayThenMonth = q.match(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\b\.?(?:[,\s]+(\d{4})\b)?/,
  );

  const targetMonth = Number(localDate.slice(5, 7));
  const targetYear = Number(localDate.slice(0, 4));
  const supports = (month: number, quotedDay: number, year?: number): "ok" | "date_mismatch" => {
    const date = new Date(Date.UTC(targetYear, month - 1, day));
    if (month !== targetMonth || quotedDay !== day
      || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return "date_mismatch";
    const expectedYear = year ?? resolveDateYear(month, day, sentAt, timezone);
    return targetYear === expectedYear ? "ok" : "date_mismatch";
  };

  if (monthNamed) {
    const m = MONTHS[monthNamed[1].replace(/\.$/, "")];
    const d = Number(monthNamed[2]);
    return supports(m, d, monthNamed[3] ? Number(monthNamed[3]) : undefined);
  }
  if (dayThenMonth) {
    const d = Number(dayThenMonth[1]);
    const m = MONTHS[dayThenMonth[2]];
    return supports(m, d, dayThenMonth[3] ? Number(dayThenMonth[3]) : undefined);
  }
  for (const n of numeric) {
    const parts = n.split(/[\/\-.]/);
    const [a, b, c] = parts.map(Number);
    if (parts[0].length === 4) {
      if (b === targetMonth && c === day) return supports(b, c, a);
    } else if ((a === targetMonth && b === day) || (a === day && b === targetMonth)) {
      return supports(targetMonth, day, c === undefined ? undefined : c < 100 ? 2000 + c : c);
    }
  }
  if (numeric.length === 0) {
    if (WEEKDAYS.test(q) || VAGUE.test(q) || /\d/.test(q) === false) {
      return "date_not_explicit";
    }
  }
  return "date_mismatch";
}

export function quantityInQuote(quote: string, qty: number): boolean {
  const numbers = quote.match(/[\d][\d,]*/g) ?? [];
  return numbers.some((n) => Number(n.replace(/,/g, "")) === qty);
}

/** Offset (minutes) of `date` in `tz`, via Intl. */
function tzOffsetMs(date: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(date).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour === "24" ? "0" : parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - date.getTime();
}

/** Convert a local wall-clock time in `tz` to a UTC Date (DST-safe). */
export function localToUtc(
  y: number,
  m: number,
  d: number,
  hh: number,
  mi: number,
  ss: number,
  ms: number,
  tz: string,
): Date {
  // Iterate the offset (handles DST transitions).
  let guess = Date.UTC(y, m - 1, d, hh, mi, ss, ms);
  for (let i = 0; i < 3; i++) {
    // Intl has second precision; drop ms when measuring the offset.
    const off = tzOffsetMs(new Date(Math.floor(guess / 1000) * 1000), tz);
    const next = Date.UTC(y, m - 1, d, hh, mi, ss, ms) - off;
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

export interface VerifyInput {
  extraction: ExtractionV1;
  segments: VerifySegment[];
  sentAt: Date;
  sentTimezone?: string;
  timezone: string;
}

export function verifyExtraction(input: VerifyInput): VerifyResult {
  const { extraction, segments, sentAt, timezone, sentTimezone = timezone } = input;
  const body = segments.find((s) => s.kind === "body");
  const bodyText = body?.content ?? "";
  const unresolved: UnresolvedFact[] = [];
  const lines: VerifiedLine[] = [];

  const checkQuote = (
    lineIndex: number,
    field: string,
    quote: string | null | undefined,
  ): void => {
    if (quote == null) return;
    if (findQuote(bodyText, quote) === -1) {
      unresolved.push({ line_index: lineIndex, field, reason: "source_span" });
    }
  };

  extraction.lines.forEach((line, i) => {
    checkQuote(i, "order_quote", line.order_quote);
    checkQuote(i, "quantity_quote", line.quantity_quote);
    checkQuote(i, "new_promise.quote", line.new_promise?.quote);
    checkQuote(i, "old_promise.quote", line.old_promise?.quote);
    if (line.old_promise?.local_date) {
      const support = quoteSupportsDate(
        line.old_promise.quote, line.old_promise.local_date, sentAt, sentTimezone,
      );
      if (support !== "ok") {
        unresolved.push({ line_index: i, field: "old_promise.date", reason: support });
      }
    }

    let affected: number | null = line.affected_quantity;
    if (affected != null) {
      if (!line.quantity_quote || !quantityInQuote(line.quantity_quote, affected)) {
        unresolved.push({
          line_index: i,
          field: "affected_quantity",
          reason: "quantity_not_in_quote",
        });
        affected = null;
      }
    }

    let promise: VerifiedPromise | null = null;
    if (line.new_promise) {
      const np = line.new_promise;
      if (!np.local_date) {
        unresolved.push({
          line_index: i,
          field: "new_promise.date",
          reason: "date_not_explicit",
        });
      } else {
        const support = quoteSupportsDate(np.quote, np.local_date, sentAt, sentTimezone);
        if (support !== "ok") {
          unresolved.push({
            line_index: i,
            field: "new_promise.date",
            reason: support,
          });
        } else {
          const [y, m, d] = np.local_date.split("-").map(Number);
          let earliest: Date;
          let latest: Date;
          if (np.local_time) {
            const [hh, mi] = np.local_time.split(":").map(Number);
            earliest = localToUtc(y, m, d, hh, mi, 0, 0, timezone);
            latest = earliest;
          } else {
            earliest = localToUtc(y, m, d, 0, 0, 0, 0, timezone);
            latest = localToUtc(y, m, d, 23, 59, 59, 999, timezone);
          }
          if (latest.getTime() < sentAt.getTime()) {
            unresolved.push({
              line_index: i,
              field: "new_promise.date",
              reason: "date_before_sent_at",
            });
          } else {
            promise = {
              earliest_at: earliest.toISOString(),
              latest_at: latest.toISOString(),
              promise_state: np.promise_state,
              date_only: !np.local_time,
            };
          }
        }
      }
    }

    if (line.order_ref) {
      if (findQuote(bodyText, line.order_ref) === -1) {
        if (!line.order_quote || findQuote(bodyText, line.order_quote) === -1) {
          unresolved.push({
            line_index: i,
            field: "order_ref",
            reason: "order_ref_not_in_source",
          });
        }
      }
    }

    lines.push({
      line_index: i,
      order_ref: line.order_ref,
      line_ref: line.line_ref,
      item_ref: line.item_ref,
      affected_quantity: affected,
      quantity_scope: line.quantity_scope,
      unit: line.unit,
      new_promise: promise,
      body_evidence_id: body?.evidence_id,
    });
  });

  return { lines, unresolved };
}

/** Resolve a quoted "Month D" (no year) into the YYYY-MM-DD closest to sentAt. */
export function resolveLocalDate(
  month: number,
  day: number,
  sentAt: Date,
  timezone: string,
): string {
  const sentLocal = new Date(
    sentAt.toLocaleString("en-US", { timeZone: timezone }),
  );
  const sentYear = sentLocal.getFullYear();
  let best: { date: Date; dist: number } | null = null;
  for (const y of [sentYear - 1, sentYear, sentYear + 1]) {
    const cand = localToUtc(y, month, day, 12, 0, 0, 0, timezone);
    const dist = Math.abs(cand.getTime() - sentAt.getTime());
    if (!best || dist < best.dist) best = { date: cand, dist };
  }
  const b = best!.date;
  // Format back as local date in tz
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(b)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}
