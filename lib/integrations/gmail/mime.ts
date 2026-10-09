import { createHash } from "node:crypto";

export class MimeTooLargeError extends Error {
  constructor(size: number) {
    super(`Message exceeds maximum size of 10 MB (got ${size} bytes)`);
    this.name = "MimeTooLargeError";
  }
}

const MAX_SIZE = 10 * 1024 * 1024;
const MAX_DEPTH = 10;

export interface ParsedSegment {
  kind: "body" | "quoted" | "forwarded";
  index: number;
  content: string;
}

export interface ParsedAttachment {
  filename: string;
  mimeType: string;
  size: number;
  sha256: string;
}

export interface ParsedEmail {
  headers: {
    from: string | null;
    to: string | null;
    cc: string | null;
    replyTo: string | null;
    subject: string | null;
    date: string | null;
    messageId: string | null;
    inReplyTo: string | null;
    references: string | null;
  };
  sender: string | null;
  senderDisplayName: string | null;
  replyTo: string[];
  recipients: string[];
  sentAt: Date | null;
  rfcMessageId: string | null;
  segments: ParsedSegment[];
  attachments: ParsedAttachment[];
  bodyHash: string;
}

export function normalizeAddress(raw: string): string {
  const angle = raw.match(/<([^>]+)>/);
  const addr = (angle ? angle[1] : raw).trim();
  const at = addr.indexOf("@");
  if (at === -1) return addr.toLowerCase();
  return addr.toLowerCase();
}

function displayNameOf(raw: string): string | null {
  const angle = raw.match(/^(.*?)\s*<[^>]+>\s*$/);
  if (!angle) return null;
  const name = angle[1].trim().replace(/^"|"$/g, "");
  return name || null;
}

function addressList(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((part) => normalizeAddress(part))
    .filter((a) => a.length > 0 && a.includes("@"));
}

// ---- RFC 2047 encoded-word decoding --------------------------------------

function decodeEncodedWord(word: string): string {
  const m = word.match(/^=\?([^?]+)\?([bBqQ])\?([^?]*)\?=$/);
  if (!m) return word;
  const [, charset, enc, text] = m;
  let bytes: Buffer;
  if (enc.toUpperCase() === "B") {
    bytes = Buffer.from(text, "base64");
  } else {
    bytes = Buffer.from(
      text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_, h) =>
        String.fromCharCode(parseInt(h, 16)),
      ),
      "latin1",
    );
  }
  return decodeCharset(bytes, charset);
}

export function decodeHeaderValue(value: string): string {
  return value.replace(/=\?[^?]+\?[bBqQ]\?[^?]*\?=/g, decodeEncodedWord);
}

// ---- charsets --------------------------------------------------------------

function decodeCharset(buf: Buffer, charset: string): string {
  const cs = charset.trim().toLowerCase();
  if (cs === "utf-8" || cs === "utf8") return buf.toString("utf8");
  if (cs === "us-ascii" || cs === "ascii") {
    // Many senders mislabel utf-8 as us-ascii; prefer utf-8 when valid.
    const asUtf8 = buf.toString("utf8");
    if (!asUtf8.includes("\ufffd")) return asUtf8;
    return buf.toString("latin1").replace(/[^\x00-\x7f]/g, "?");
  }
  if (cs === "iso-8859-1" || cs === "latin1") return buf.toString("latin1");
  return buf.toString("utf8"); // lossy fallback
}

// ---- transfer encodings -----------------------------------------------------

function decodeTransfer(buf: Buffer, encoding: string): Buffer {
  const enc = encoding.trim().toLowerCase();
  if (enc === "base64") {
    return Buffer.from(buf.toString("latin1").replace(/\s+/g, ""), "base64");
  }
  if (enc === "quoted-printable") {
    const s = buf.toString("latin1");
    const out = s
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    return Buffer.from(out, "latin1");
  }
  return buf;
}

// ---- header parsing ----------------------------------------------------------

interface RawPart {
  headers: Map<string, string[]>;
  body: Buffer;
}

function splitHeaders(raw: Buffer): RawPart {
  // Find header/body separator (\r\n\r\n or \n\n)
  const asLatin = raw.toString("latin1");
  let idx = asLatin.indexOf("\r\n\r\n");
  let sepLen = 4;
  if (idx === -1) {
    idx = asLatin.indexOf("\n\n");
    sepLen = 2;
  }
  const headerBuf = idx === -1 ? raw : raw.subarray(0, idx);
  const body = idx === -1 ? Buffer.alloc(0) : raw.subarray(idx + sepLen);

  const headers = new Map<string, string[]>();
  const lines = headerBuf.toString("latin1").split(/\r?\n/);
  let current: string | null = null;
  for (const line of lines) {
    if (/^[ \t]/.test(line) && current) {
      const list = headers.get(current)!;
      list[list.length - 1] += " " + line.trim();
      continue;
    }
    const m = line.match(/^([^:\s]+)\s*:\s*(.*)$/);
    if (m) {
      current = m[1].toLowerCase();
      const list = headers.get(current) ?? [];
      list.push(m[2]);
      headers.set(current, list);
    } else {
      current = null;
    }
  }
  return { headers, body };
}

function header(part: RawPart, name: string): string | null {
  const v = part.headers.get(name.toLowerCase());
  return v && v.length ? decodeHeaderValue(v[0]).trim() : null;
}

function contentTypeOf(part: RawPart): { type: string; params: Record<string, string> } {
  const raw = part.headers.get("content-type")?.[0] ?? "text/plain";
  const segs = raw.split(";").map((s) => s.trim());
  const params: Record<string, string> = {};
  for (const seg of segs.slice(1)) {
    const eq = seg.indexOf("=");
    if (eq === -1) continue;
    const k = seg.slice(0, eq).trim().toLowerCase();
    let v = seg.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    params[k] = decodeHeaderValue(v);
  }
  return { type: segs[0].toLowerCase() || "text/plain", params };
}

// ---- HTML to text -----------------------------------------------------------

export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
  s = s
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s;
}

// ---- body segmentation -------------------------------------------------------

const FORWARD_START =
  /^\s*(-{2,}\s*forwarded message\s*-{2,}|begin forwarded message:?)/i;
const QUOTED_WROTE = /^on .+ wrote:$/i;

function segmentBody(text: string): ParsedSegment[] {
  const lines = text.split(/\r?\n/);
  const segments: ParsedSegment[] = [];
  let kind: ParsedSegment["kind"] = "body";
  let buf: string[] = [];
  let index = 0;

  const flush = () => {
    const content = buf.join("\n").replace(/^\n+|\n+$/g, "");
    if (content.length > 0) {
      segments.push({ kind, index, content });
      index += 1;
    }
    buf = [];
  };

  const signatureReached = { v: false };
  for (const line of lines) {
    if (/^--\s*$/.test(line)) signatureReached.v = true;
    if (kind === "body") {
      if (FORWARD_START.test(line)) {
        flush();
        kind = "forwarded";
        buf.push(line);
        continue;
      }
      if (QUOTED_WROTE.test(line)) {
        flush();
        kind = "quoted";
        buf.push(line);
        continue;
      }
      if (/^>/.test(line)) {
        flush();
        kind = "quoted";
        buf.push(line);
        continue;
      }
      buf.push(line);
    } else {
      // Inside a quoted/forwarded run, a forwarded-marker boundary starts a
      // new segment; everything else continues the current segment.
      if (FORWARD_START.test(line) && kind !== "forwarded") {
        flush();
        kind = "forwarded";
        buf.push(line);
        continue;
      }
      buf.push(line);
    }
  }
  flush();
  void signatureReached;
  return segments;
}

// ---- multipart walk -----------------------------------------------------------

interface CollectedParts {
  textParts: { content: string }[];
  htmlParts: { content: string }[];
  attachments: ParsedAttachment[];
}

function filenameOf(part: RawPart, params: Record<string, string>): string | null {
  const disp = part.headers.get("content-disposition")?.[0] ?? "";
  const fn = disp.match(/filename\*?="?([^";]+)"?/i)?.[1] ?? params.name ?? null;
  return fn ? decodeHeaderValue(fn).trim() : null;
}

function walk(part: RawPart, depth: number, out: CollectedParts): void {
  if (depth > MAX_DEPTH) return;
  const { type, params } = contentTypeOf(part);

  if (type.startsWith("multipart/")) {
    const boundary = params.boundary;
    if (!boundary) return;
    const raw = part.body.toString("latin1");
    const chunks = raw.split("--" + boundary);
    for (let i = 1; i < chunks.length; i++) {
      let chunk = chunks[i];
      if (chunk.startsWith("--")) break; // closing delimiter
      if (chunk.startsWith("\r\n")) chunk = chunk.slice(2);
      else if (chunk.startsWith("\n")) chunk = chunk.slice(1);
      if (!chunk.trim()) continue;
      walk(splitHeaders(Buffer.from(chunk, "latin1")), depth + 1, out);
    }
    return;
  }

  const disp = part.headers.get("content-disposition")?.[0].toLowerCase() ?? "";
  const filename = filenameOf(part, params);
  const encoding = part.headers.get("content-transfer-encoding")?.[0] ?? "7bit";
  const decoded = decodeTransfer(part.body, encoding);

  if (disp.includes("attachment") || filename) {
    out.attachments.push({
      filename: filename ?? "attachment",
      mimeType: type,
      size: part.body.length,
      sha256: createHash("sha256").update(part.body).digest("hex"),
    });
    return;
  }

  const charset = params.charset ?? "us-ascii";
  const text = decodeCharset(decoded, charset);
  if (type === "text/plain") {
    out.textParts.push({ content: text });
  } else if (type === "text/html") {
    out.htmlParts.push({ content: htmlToText(text) });
  } else {
    // Unknown inline leaf part: treat as text to avoid silently dropping.
    out.textParts.push({ content: text });
  }
}

// ---- entry point --------------------------------------------------------------

export function parseRawEmail(raw: Buffer | string): ParsedEmail {
  const buf = typeof raw === "string" ? Buffer.from(raw, "utf8") : raw;
  if (buf.length > MAX_SIZE) throw new MimeTooLargeError(buf.length);

  const root = splitHeaders(buf);
  const collected: CollectedParts = { textParts: [], htmlParts: [], attachments: [] };
  walk(root, 0, collected);

  const text =
    collected.textParts.length > 0
      ? collected.textParts.map((p) => p.content).join("\n")
      : collected.htmlParts.map((p) => p.content).join("\n");

  const segments = segmentBody(text);

  const from = header(root, "from");
  const replyTo = header(root, "reply-to");
  const dateRaw = header(root, "date");
  const messageId = header(root, "message-id");
  const to = header(root, "to");
  const cc = header(root, "cc");

  let sentAt: Date | null = null;
  if (dateRaw) {
    const d = new Date(dateRaw);
    if (!Number.isNaN(d.getTime())) sentAt = d;
  }

  const bodyContent = segments.find((s) => s.kind === "body")?.content ?? text;

  return {
    headers: {
      from,
      to,
      cc,
      replyTo,
      subject: header(root, "subject"),
      date: dateRaw,
      messageId,
      inReplyTo: header(root, "in-reply-to"),
      references: header(root, "references"),
    },
    sender: from ? normalizeAddress(from) : null,
    senderDisplayName: from ? displayNameOf(from) : null,
    replyTo: addressList(replyTo),
    recipients: [...addressList(to), ...addressList(cc)],
    sentAt,
    rfcMessageId: messageId,
    segments,
    attachments: collected.attachments,
    bodyHash: createHash("sha256").update(bodyContent).digest("hex"),
  };
}
