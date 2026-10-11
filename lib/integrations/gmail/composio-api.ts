import { normalizeAddress } from "./mime";
import type {
  GmailApi,
  GmailReconciliationContext,
} from "./api";
import type { ComposioGmailClient } from "./composio-client";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asObject(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

function deepValues(value: unknown, keys: string[]): unknown[] {
  if (Array.isArray(value)) return value.flatMap((item) => deepValues(item, keys));
  if (!isObject(value)) return [];
  const found = keys.flatMap((key) => (key in value ? [value[key]] : []));
  return [...found, ...Object.values(value).flatMap((item) => deepValues(item, keys))];
}

function deepString(value: unknown, keys: string[]): string | undefined {
  return deepValues(value, keys).find(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
}

function deepStrings(value: unknown, keys: string[]): string[] {
  for (const item of deepValues(value, keys)) {
    if (Array.isArray(item)) {
      const strings = item.filter((entry): entry is string => typeof entry === "string");
      if (strings.length > 0) return strings;
    }
  }
  return [];
}

function toolData(response: unknown): unknown {
  const root = asObject(response);
  if (root.successful === false || root.error) {
    const error = asObject(root.error);
    const status = Number(error.status ?? root.status ?? root.statusCode);
    throw Object.assign(
      new Error(
        String(error.message ?? root.message ?? root.error ?? "Composio tool execution failed"),
      ),
      Number.isFinite(status) && status > 0 ? { status } : {},
    );
  }
  return root.data ?? response;
}

function decodePageToken(value: string | undefined): {
  token?: string;
  historyId?: string;
} {
  if (!value) return {};
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as JsonObject;
    if (typeof decoded.token === "string") {
      return {
        token: decoded.token,
        historyId: typeof decoded.historyId === "string" ? decoded.historyId : undefined,
      };
    }
  } catch {
    return { token: value };
  }
  return { token: value };
}

function encodePageToken(token: string | undefined, historyId: string): string | undefined {
  if (!token) return undefined;
  return Buffer.from(JSON.stringify({ token, historyId }), "utf8").toString("base64url");
}

function decodeRaw(value: string): Buffer {
  if (/^(?:From|To|Subject|Message-ID|MIME-Version):/i.test(value)) {
    return Buffer.from(value, "utf8");
  }
  return Buffer.from(value, "base64url");
}

function parseRawHeaders(raw: Buffer): { headers: Map<string, string>; body: string } {
  const text = raw.toString("utf8");
  const separator = text.search(/\r?\n\r?\n/);
  if (separator < 0) return { headers: new Map(), body: "" };
  const headerText = text.slice(0, separator);
  const body = text.slice(separator).replace(/^\r?\n\r?\n/, "");
  const unfolded = headerText.replace(/\r?\n[ \t]+/g, " ");
  const headers = new Map<string, string>();
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }
  }
  return { headers, body };
}

function parseInternalDate(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function normalizeMessage(
  data: unknown,
  requestedId: string,
): { id: string; threadId: string; labelIds: string[]; internalDate: number; raw: Buffer } {
  const rawValue = deepString(data, ["raw", "rawData", "raw_data", "raw_email"]);
  const id = deepString(data, ["id", "message_id", "messageId"]) ?? requestedId;
  let raw: Buffer;
  if (rawValue) {
    raw = decodeRaw(rawValue);
  } else {
    const payload = deepValues(data, ["payload"]).find(isObject);
    const payloadHeaders = Array.isArray(payload?.headers)
      ? payload.headers
          .map((entry) => {
            const header = asObject(entry);
            const name = typeof header.name === "string" ? header.name : "";
            const value = typeof header.value === "string" ? header.value : "";
            return name && value ? `${name}: ${value.replace(/[\r\n]+/g, " ")}` : "";
          })
          .filter(Boolean)
      : [];
    const headers = new Map<string, string>();
    for (const line of payloadHeaders) {
      const colon = line.indexOf(":");
      if (colon > 0) headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
    }
    const header = (name: string, keys: string[]): string | undefined =>
      headers.get(name.toLowerCase()) ?? deepString(data, keys);
    const requiredHeaders = [
      ["From", header("from", ["sender", "from"])],
      ["To", header("to", ["to", "recipient"])],
      ["Subject", header("subject", ["subject"])],
      ["Date", header("date", ["messageTimestamp", "message_timestamp"])],
      ["Message-ID", header("message-id", ["rfcMessageId", "rfc_message_id"])],
    ]
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && !!entry[1])
      .map(([name, value]) => `${name}: ${value.replace(/[\r\n]+/g, " ")}`);
    const extraHeaders = payloadHeaders.filter(
      (line) => !/^(from|to|subject|date|message-id):/i.test(line),
    );
    const body =
      deepString(data, ["messageText", "message_text", "textBody", "text_body"]) ??
      deepString(payload, ["messageText", "message_text", "text"]) ??
      "";
    raw = Buffer.from(
      [
        ...requiredHeaders,
        ...extraHeaders,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: 8bit",
        "",
        body.replace(/\r?\n/g, "\r\n"),
      ].join("\r\n"),
      "utf8",
    );
  }
  return {
    id,
    threadId: deepString(data, ["threadId", "thread_id"]) ?? "",
    labelIds: deepStrings(data, ["labelIds", "label_ids"]),
    internalDate: parseInternalDate(
      deepValues(data, ["internalDate", "internal_date", "messageTimestamp", "message_timestamp"])[0],
    ),
    raw,
  };
}

function searchEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]/g, " ");
}

function sameMessage(
  message: { raw: Buffer },
  context: GmailReconciliationContext,
): boolean {
  const { headers, body } = parseRawHeaders(message.raw);
  const recipient = headers.get("to") ?? "";
  const subject = headers.get("subject") ?? "";
  return (
    normalizeAddress(recipient) === normalizeAddress(context.to) &&
    subject === context.subject &&
    body.trim() === context.body.trim()
  );
}

export function createComposioGmailApi(
  client: ComposioGmailClient,
  orgId: string,
  connectedAccountId: string,
): GmailApi {
  const execute = async (slug: string, args: Record<string, unknown>): Promise<unknown> =>
    toolData(
      await client.tools.execute(slug, {
        userId: orgId,
        connectedAccountId,
        arguments: args,
      }),
    );

  const fetchMessages = async (
    query: string,
    pageToken?: string,
    maxResults = 100,
  ): Promise<{ ids: string[]; nextPageToken?: string }> => {
    const data = await execute("GMAIL_FETCH_EMAILS", {
      query,
      ids_only: true,
      user_id: "me",
      verbose: false,
      include_payload: false,
      max_results: maxResults,
      ...(pageToken ? { page_token: pageToken } : {}),
    });
    const records = deepValues(data, ["messages", "emails", "results", "items"]).find(
      Array.isArray,
    );
    const ids = Array.isArray(records)
      ? records
          .map((entry) =>
            typeof entry === "string"
              ? entry
              : deepString(entry, ["id", "message_id", "messageId"]),
          )
          .filter((id): id is string => Boolean(id))
      : [];
    return {
      ids,
      nextPageToken: deepString(data, ["nextPageToken", "next_page_token", "next_cursor"]),
    };
  };

  return {
    async getProfile() {
      return { emailAddress: "", historyId: new Date().toISOString() };
    },
    async listMessages({ q, pageToken, maxResults }) {
      return fetchMessages(q ?? "newer_than:7d", pageToken, maxResults);
    },
    async listHistory({ startHistoryId, pageToken }) {
      const decoded = decodePageToken(pageToken);
      const historyId = decoded.historyId ?? new Date().toISOString();
      const start = Date.parse(startHistoryId);
      if (!Number.isFinite(start)) {
        throw Object.assign(new Error("invalid Composio Gmail history cursor"), {
          status: 404,
        });
      }
      const after = Math.max(0, Math.floor(start / 1000) - 2);
      const page = await fetchMessages(
        `after:${after}`,
        decoded.token,
        100,
      );
      return {
        messageIds: page.ids,
        historyId,
        nextPageToken: encodePageToken(page.nextPageToken, historyId),
      };
    },
    async getRaw(id) {
      const data = await execute("GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", {
        message_id: id,
        format: "raw",
        user_id: "me",
      });
      return normalizeMessage(data, id);
    },
    async send({ raw }) {
      const parsed = parseRawHeaders(Buffer.from(raw, "utf8"));
      const recipient = parsed.headers.get("to") ?? "";
      const subject = parsed.headers.get("subject") ?? "";
      const messageId = parsed.headers.get("message-id") ?? "";
      return this.sendStructured
        ? this.sendStructured({
            to: recipient,
            subject,
            body: parsed.body,
            rfcMessageId: messageId,
          })
        : Promise.reject(new Error("Composio structured send is unavailable"));
    },
    async sendStructured({ to, subject, body }) {
      let response = await execute("GMAIL_SEND_EMAIL", {
        recipient_email: to,
        subject,
        body,
        is_html: false,
        user_id: "me",
      });
      let messageId = deepString(response, ["id", "message_id", "messageId"]);
      const draftId = deepString(response, ["draft_id", "draftId"]);
      if (!messageId && draftId) {
        response = await execute("GMAIL_SEND_DRAFT", { draft_id: draftId });
        messageId = deepString(response, ["id", "message_id", "messageId"]);
      }
      if (!messageId) {
        throw new Error("Composio Gmail send response did not include a provider message id");
      }
      return {
        id: messageId,
        threadId: deepString(response, ["threadId", "thread_id"]) ?? "",
      };
    },
    async findSentByRfcMessageId(rfcId, context) {
      const rfcValue = rfcId.replace(/^<|>$/g, "");
      const exact = await fetchMessages(`in:sent rfc822msgid:${rfcValue}`, undefined, 2);
      if (exact.ids.length === 1) {
        const message = await this.getRaw(exact.ids[0]);
        return { id: message.id, threadId: message.threadId };
      }
      if (exact.ids.length > 1 || !context?.allowContentMatch) return null;

      const query = `in:sent to:${normalizeAddress(context.to)} subject:"${searchEscape(
        context.subject,
      )}" newer_than:30d`;
      const candidates = await fetchMessages(query, undefined, 25);
      const matches: { id: string; threadId: string }[] = [];
      for (const id of candidates.ids) {
        const message = await this.getRaw(id);
        if (sameMessage(message, context)) {
          matches.push({ id: message.id, threadId: message.threadId });
        }
        if (matches.length > 1) return null;
      }
      return matches[0] ?? null;
    },
  };
}
