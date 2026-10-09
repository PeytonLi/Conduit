import { describe, expect, it } from "vitest";
import {
  credentialKeyVersion,
  decryptCredential,
  encryptCredential,
  signState,
} from "@/lib/integrations/gmail/crypto";
import {
  quoteSupportsDate,
  quantityInQuote,
  verifyExtraction,
  localToUtc,
} from "@/lib/agent/extraction-verify";
import { verifyCallback, buildAuthorizationUrl } from "@/lib/integrations/gmail/oauth";
import type { ExtractionV1 } from "@/lib/agent/extraction-schema";

const KEY = `v1:${Buffer.alloc(32, 7).toString("base64")}`;
const KEY2 = `v1:${Buffer.alloc(32, 9).toString("base64")}`;

describe("inbox-crypto: credential encryption", () => {
  it("roundtrips a refresh token", () => {
    const b64 = encryptCredential("refresh-token-xyz", KEY);
    expect(decryptCredential(b64, KEY, "v1")).toBe("refresh-token-xyz");
  });

  it("rejects a key version mismatch", () => {
    const b64 = encryptCredential("x", KEY);
    expect(() => decryptCredential(b64, KEY, "v2")).toThrow();
  });

  it("detects tampering and wrong keys", () => {
    const b64 = encryptCredential("secret", KEY);
    const bytes = Buffer.from(b64, "base64");
    bytes[20] ^= 0xff;
    expect(() =>
      decryptCredential(bytes.toString("base64"), KEY, "v1"),
    ).toThrow();
    const b64b = encryptCredential("secret", KEY);
    expect(() => decryptCredential(b64b, KEY2, "v1")).toThrow();
  });

  it("exposes the key version prefix", () => {
    expect(credentialKeyVersion(KEY)).toBe("v1");
  });
});

describe("AT-22 oauth state verify", () => {
  const payload = {
    o: "org-1",
    u: "user-1",
    n: "nonce-1",
    r: "https://app.example/cb",
    exp: 2000,
  };
  const fakeNow = () => new Date(1000 * 1000);
  const base = {
    nonceCookie: "nonce-1",
    sessionUserId: "user-1",
    sessionOrgId: "org-1",
    sessionRole: "owner",
    redirectUri: "https://app.example/cb",
    signingKey: KEY,
    now: fakeNow,
  };

  it("AT-22 accepts a valid state", () => {
    const state = signState(payload, KEY);
    const r = verifyCallback({ state, ...base });
    expect(r).toEqual({ ok: true, orgId: "org-1", userId: "user-1" });
  });

  it("AT-22 rejects bad signature", () => {
    const state = signState(payload, KEY) + "x";
    expect(verifyCallback({ state, ...base })).toEqual({
      ok: false,
      error: "bad_signature",
    });
  });

  it("AT-22 rejects expired state", () => {
    const state = signState({ ...payload, exp: 500 }, KEY);
    expect(verifyCallback({ state, ...base })).toEqual({
      ok: false,
      error: "expired",
    });
  });

  it("AT-22 rejects nonce mismatch", () => {
    const state = signState(payload, KEY);
    expect(
      verifyCallback({ state, ...base, nonceCookie: "other" }),
    ).toEqual({ ok: false, error: "nonce_mismatch" });
  });

  it("AT-22 rejects different user", () => {
    const state = signState(payload, KEY);
    expect(
      verifyCallback({ state, ...base, sessionUserId: "user-2" }),
    ).toEqual({ ok: false, error: "user_mismatch" });
  });

  it("AT-22 rejects different org", () => {
    const state = signState(payload, KEY);
    expect(
      verifyCallback({ state, ...base, sessionOrgId: "org-2" }),
    ).toEqual({ ok: false, error: "org_mismatch" });
  });

  it("AT-22 rejects non-owner role", () => {
    const state = signState(payload, KEY);
    expect(
      verifyCallback({ state, ...base, sessionRole: "operator" }),
    ).toEqual({ ok: false, error: "not_owner" });
  });

  it("AT-22 builds an authorization url containing signed state and scopes", () => {
    const url = buildAuthorizationUrl({
      oauth2: {
        generateAuthUrl(opts?: unknown) {
          const o = opts as { state: string; scope: string[] };
          return `https://accounts.example/auth?state=${o.state}&scope=${o.scope}`;
        },
      },
      orgId: "org-1",
      userId: "user-1",
      nonce: "n",
      redirectUri: "https://app.example/cb",
      signingKey: KEY,
      now: fakeNow,
    });
    expect(url).toContain("gmail.readonly");
    expect(url).toContain("gmail.send");
  });
});

const seg = (content: string) => ({
  kind: "body" as const,
  index: 0,
  content,
});

const sentAt = new Date("2026-10-12T15:00:00Z");

function extraction(lines: Partial<ExtractionV1["lines"][0]>[]): ExtractionV1 {
  return {
    schema_version: 1,
    is_delay_notice: true,
    lines: lines.map((l) => ({
      order_ref: null,
      line_ref: null,
      item_ref: null,
      affected_quantity: null,
      quantity_scope: "all_remaining",
      unit: null,
      old_promise: null,
      new_promise: null,
      quantity_quote: null,
      order_quote: null,
      ...l,
    })),
    notes_for_reviewer: "",
  };
}

describe("inbox-verify: deterministic verification", () => {
  it("rejects a bare weekday as a promise date", () => {
    const result = verifyExtraction({
      extraction: extraction([
        {
          new_promise: {
            quote: "delayed until Friday",
            local_date: "2026-10-16",
            local_time: null,
            promise_state: "estimated",
          },
        },
      ]),
      segments: [seg("your order is delayed until Friday, sorry")],
      sentAt,
      timezone: "America/Los_Angeles",
    });
    expect(
      result.unresolved.some(
        (u) => u.field === "new_promise.date" && u.reason === "date_not_explicit",
      ),
    ).toBe(true);
  });

  it("converts local dates to UTC across DST correctly", () => {
    // PDT (UTC-7) on Oct 16 2026
    const d = localToUtc(2026, 10, 16, 8, 0, 0, 0, "America/Los_Angeles");
    expect(d.toISOString()).toBe("2026-10-16T15:00:00.000Z");
    // PST (UTC-8) in winter
    const w = localToUtc(2026, 1, 16, 8, 0, 0, 0, "America/Los_Angeles");
    expect(w.toISOString()).toBe("2026-01-16T16:00:00.000Z");
  });

  it("date-only promises produce earliest/latest day bounds", () => {
    const result = verifyExtraction({
      extraction: extraction([
        {
          new_promise: {
            quote: "Monday, October 19",
            local_date: "2026-10-19",
            local_time: null,
            promise_state: "confirmed",
          },
        },
      ]),
      segments: [seg("moves to Monday, October 19")],
      sentAt,
      timezone: "America/Los_Angeles",
    });
    const p = result.lines[0].new_promise!;
    expect(p.date_only).toBe(true);
    expect(p.earliest_at).toBe("2026-10-19T07:00:00.000Z");
    expect(p.latest_at).toBe("2026-10-20T06:59:59.999Z");
  });

  it("requires the quantity to appear in the quote", () => {
    expect(quantityInQuote("4,000 cartons", 4000)).toBe(true);
    expect(quantityInQuote("200 units", 4000)).toBe(false);
    const result = verifyExtraction({
      extraction: extraction([
        {
          affected_quantity: 4000,
          quantity_scope: "partial",
          quantity_quote: "two hundred cartons",
        },
      ]),
      segments: [seg("two hundred cartons delayed")],
      sentAt,
      timezone: "America/Los_Angeles",
    });
    expect(
      result.unresolved.some(
        (u) => u.field === "affected_quantity" && u.reason === "quantity_not_in_quote",
      ),
    ).toBe(true);
  });

  it("flags quotes not found in the body segment", () => {
    const result = verifyExtraction({
      extraction: extraction([
        {
          order_ref: "PO-1042",
          order_quote: "totally different text",
        },
      ]),
      segments: [seg("PO-1042 delayed")],
      sentAt,
      timezone: "UTC",
    });
    expect(
      result.unresolved.some((u) => u.reason === "source_span"),
    ).toBe(true);
  });

  it("quoteSupportsDate accepts month name + day and ISO numerics", () => {
    expect(quoteSupportsDate("friday, october 16", "2026-10-16")).toBe("ok");
    expect(quoteSupportsDate("on 10/16", "2026-10-16")).toBe("ok");
    expect(quoteSupportsDate("october 17", "2026-10-16")).toBe("date_mismatch");
  });
});
