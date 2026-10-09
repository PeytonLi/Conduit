import { describe, expect, it } from "vitest";
import {
  htmlToText,
  normalizeAddress,
  parseRawEmail,
  MimeTooLargeError,
  decodeHeaderValue,
} from "@/lib/integrations/gmail/mime";

describe("inbox-mime: parseRawEmail", () => {
  it("prefers text/plain over text/html in multipart/alternative", () => {
    const raw = [
      "From: Alyssa <alyssa@baycarton.example.com>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/alternative; boundary="ALT"',
      "",
      "--ALT",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "plain body here",
      "--ALT",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>html body here</p>",
      "--ALT--",
    ].join("\r\n");
    const parsed = parseRawEmail(raw);
    expect(parsed.segments[0].content).toContain("plain body here");
    expect(parsed.segments[0].content).not.toContain("html body");
  });

  it("sanitizes an html-only message, removing scripts", () => {
    const raw = [
      "From: a@b.example",
      'Content-Type: text/html; charset=utf-8',
      "",
      "<html><head><script>alert(1)</script></head><body><p>Hello <b>world</b></p></body></html>",
    ].join("\r\n");
    const parsed = parseRawEmail(raw);
    const text = parsed.segments.map((s) => s.content).join("\n");
    expect(text).toContain("Hello world");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("<script>");
  });

  it("decodes base64 and quoted-printable bodies", () => {
    const raw = [
      "From: a@b.example",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("hello delayed shipment").toString("base64"),
    ].join("\r\n");
    expect(parseRawEmail(raw).segments[0].content).toContain(
      "hello delayed shipment",
    );
    const qp = [
      "From: a@b.example",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "caf=C3=A9 shipment=20delay",
    ].join("\r\n");
    expect(parseRawEmail(qp).segments[0].content).toContain("café shipment");
  });

  it("decodes RFC2047 encoded-word subjects (B and Q)", () => {
    expect(decodeHeaderValue("=?UTF-8?B?ZGVsYXk=?=")).toBe("delay");
    expect(decodeHeaderValue("=?UTF-8?Q?delay_notice?=")).toBe("delay notice");
    const raw = [
      "From: a@b.example",
      "Subject: =?UTF-8?Q?PO-1042_delayed?=",
      "",
      "x",
    ].join("\r\n");
    expect(parseRawEmail(raw).headers.subject).toBe("PO-1042 delayed");
  });

  it("computes attachment sha256 without storing content", () => {
    const content = Buffer.from("attachment bytes");
    const raw = [
      "From: a@b.example",
      'Content-Type: multipart/mixed; boundary="M"',
      "",
      "--M",
      "Content-Type: text/plain",
      "",
      "see attached",
      "--M",
      "Content-Type: application/pdf",
      'Content-Disposition: attachment; filename="quote.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      content.toString("base64"),
      "--M--",
    ].join("\r\n");
    const parsed = parseRawEmail(raw);
    expect(parsed.attachments).toHaveLength(1);
    const att = parsed.attachments[0];
    expect(att.filename).toBe("quote.pdf");
    expect(att.mimeType).toBe("application/pdf");
    expect(att.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("splits quoted and forwarded segments", () => {
    const raw = [
      "From: a@b.example",
      "",
      "new reply text",
      "",
      "> On Oct 1, someone wrote:",
      "> original quoted line",
      "---------- Forwarded message ---------",
      "forwarded content",
    ].join("\r\n");
    const parsed = parseRawEmail(raw);
    const kinds = parsed.segments.map((s) => s.kind);
    expect(kinds[0]).toBe("body");
    expect(kinds).toContain("quoted");
    expect(kinds).toContain("forwarded");
    expect(parsed.segments.find((s) => s.kind === "body")!.content).toContain(
      "new reply text",
    );
  });

  it("rejects messages over 10 MB", () => {
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 0x61);
    expect(() => parseRawEmail(big)).toThrow(MimeTooLargeError);
  });

  it("normalizes addresses and ignores display names", () => {
    expect(normalizeAddress("Alyssa Reed <ALYSSA@BayCarton.example.com>")).toBe(
      "alyssa@baycarton.example.com",
    );
    expect(normalizeAddress("  user@x.example ")).toBe("user@x.example");
  });

  it("htmlToText strips head/style blocks and entities", () => {
    const out = htmlToText(
      "<head><style>x{}</style></head><p>a&nbsp;b &amp; c<br>d</p>",
    );
    expect(out).toContain("a b & c");
    expect(out).toContain("d");
    expect(out).not.toContain("<");
  });
});
