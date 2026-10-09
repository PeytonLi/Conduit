import { google, type Auth, type gmail_v1 } from "googleapis";

export interface GmailApi {
  getProfile(): Promise<{ emailAddress: string; historyId: string }>;
  listMessages(args: {
    q?: string;
    pageToken?: string;
    maxResults?: number;
  }): Promise<{ ids: string[]; nextPageToken?: string }>;
  listHistory(args: {
    startHistoryId: string;
    pageToken?: string;
  }): Promise<{ messageIds: string[]; historyId: string; nextPageToken?: string }>;
  getRaw(id: string): Promise<{
    id: string;
    threadId: string;
    labelIds: string[];
    internalDate: number;
    raw: Buffer;
  }>;
  send(args: { raw: string; threadId?: string }): Promise<{ id: string; threadId: string }>;
  findSentByRfcMessageId(rfcId: string): Promise<{ id: string; threadId: string } | null>;
}

export type GmailErrorKind =
  | "invalid_cursor"
  | "revoked"
  | "expired"
  | "rate_limited"
  | "transient"
  | "invalid_request";

export function classifyGmailError(err: unknown): GmailErrorKind {
  const anyErr = err as {
    code?: number | string;
    status?: number;
    message?: string;
    response?: { status?: number };
  };
  const status =
    anyErr?.response?.status ??
    (typeof anyErr?.code === "number" ? anyErr.code : undefined) ??
    anyErr?.status;
  const msg = anyErr?.message ?? "";
  if (msg.includes("invalid_grant")) return "revoked";
  if (status === 404) return "invalid_cursor";
  if (status === 401) return "expired";
  if (status === 429) return "rate_limited";
  if (status !== undefined && status >= 500) return "transient";
  if (status !== undefined && status >= 400) return "invalid_request";
  // network errors / timeouts (e.g. ECONNRESET, ETIMEDOUT, fetch failed)
  return "transient";
}

export function createGoogleGmailApi(oauth2: Auth.OAuth2Client): GmailApi {
  const gmail: gmail_v1.Gmail = google.gmail({ version: "v1", auth: oauth2 });
  return {
    async getProfile() {
      const res = await gmail.users.getProfile({ userId: "me" });
      return {
        emailAddress: res.data.emailAddress ?? "",
        historyId: res.data.historyId ?? "",
      };
    },
    async listMessages({ q, pageToken, maxResults }) {
      const res = await gmail.users.messages.list({
        userId: "me",
        q,
        pageToken,
        maxResults: maxResults ?? 100,
      });
      return {
        ids: (res.data.messages ?? [])
          .map((m) => m.id)
          .filter((id): id is string => !!id),
        nextPageToken: res.data.nextPageToken ?? undefined,
      };
    },
    async listHistory({ startHistoryId, pageToken }) {
      const res = await gmail.users.history.list({
        userId: "me",
        startHistoryId,
        pageToken,
        historyTypes: ["messageAdded"],
      });
      const ids = new Set<string>();
      for (const h of res.data.history ?? []) {
        for (const added of h.messagesAdded ?? []) {
          if (added.message?.id) ids.add(added.message.id);
        }
      }
      return {
        messageIds: [...ids],
        historyId: res.data.historyId ?? startHistoryId,
        nextPageToken: res.data.nextPageToken ?? undefined,
      };
    },
    async getRaw(id) {
      const res = await gmail.users.messages.get({
        userId: "me",
        id,
        format: "raw",
      });
      return {
        id: res.data.id ?? id,
        threadId: res.data.threadId ?? "",
        labelIds: (res.data.labelIds ?? []).filter((l): l is string => !!l),
        internalDate: Number(res.data.internalDate ?? 0),
        raw: Buffer.from(res.data.raw ?? "", "base64url"),
      };
    },
    async send({ raw, threadId }) {
      const res = await gmail.users.messages.send({
        userId: "me",
        requestBody: {
          raw: Buffer.from(raw, "utf8").toString("base64url"),
          threadId,
        },
      });
      return { id: res.data.id ?? "", threadId: res.data.threadId ?? "" };
    },
    async findSentByRfcMessageId(rfcId) {
      const res = await gmail.users.messages.list({
        userId: "me",
        q: `in:sent rfc822msgid:${rfcId}`,
        maxResults: 1,
      });
      const msg = res.data.messages?.[0];
      if (!msg?.id) return null;
      return { id: msg.id, threadId: msg.threadId ?? "" };
    },
  };
}
