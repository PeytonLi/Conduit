import type { SupplierEmailTransport } from "@/lib/integrations/mailbox/transport";
import { GRAPH_BASE_URL } from "./config";
import {
  assertGraphUrl,
  GraphApiError,
  toGraphApiError,
  type FetchLike,
} from "./http";
import { deltaPageSchema, graphProfileSchema, messageListSchema, messageRefSchema } from "./schemas";

export interface OutlookMessageRef {
  id: string;
  conversationId: string | null;
  /** Lower-cased sender address, when Graph reports one. */
  fromAddress: string | null;
}

export interface OutlookDeltaPage {
  messages: OutlookMessageRef[];
  nextLink?: string;
  deltaLink?: string;
}

export interface OutlookApi extends SupplierEmailTransport {
  getProfile(): Promise<{ emailAddress: string }>;
  /**
   * One page of Inbox changes. With `cursor` (a Graph next or delta link) the
   * listing resumes there; otherwise it starts fresh from `since`.
   */
  listInboxDelta(args: { cursor?: string; since?: Date; pageSize?: number }): Promise<OutlookDeltaPage>;
  /** The message as RFC 5322 MIME, ready for ingestMessage. */
  getRaw(id: string): Promise<{ id: string; raw: Buffer }>;
}

/** Quotes a value for an OData string literal. */
function odataString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export interface GraphApiOptions {
  getAccessToken: () => Promise<string>;
  fetchImpl: FetchLike;
  baseUrl?: string;
}

/**
 * Graph mail adapter. Requests ask for immutable ids so a message keeps one
 * id when it is moved between folders (and when a draft moves to Sent Items),
 * which keeps provider_message_id a stable dedupe key.
 */
export function createGraphOutlookApi({
  getAccessToken,
  fetchImpl,
  baseUrl = GRAPH_BASE_URL,
}: GraphApiOptions): OutlookApi {
  async function request(
    method: "GET" | "POST",
    target: string,
    options: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const token = await getAccessToken();
    const response = await fetchImpl(target, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        prefer: 'IdType="ImmutableId"',
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (!response.ok) throw await toGraphApiError(response);
    return response;
  }

  const url = (path: string) => `${baseUrl}${path}`;

  async function findInFolder(
    folder: "drafts" | "sentitems",
    rfcId: string,
  ): Promise<{ id: string; threadId: string } | null> {
    const response = await request(
      "GET",
      url(
        `/me/mailFolders/${folder}/messages?$filter=${encodeURIComponent(
          `internetMessageId eq ${odataString(rfcId)}`,
        )}&$select=id,conversationId&$top=1`,
      ),
    );
    const list = messageListSchema.parse(await response.json());
    const found = list.value[0];
    return found ? { id: found.id, threadId: found.conversationId ?? "" } : null;
  }

  return {
    async getProfile() {
      const response = await request("GET", url("/me?$select=mail,userPrincipalName"));
      const profile = graphProfileSchema.parse(await response.json());
      const address = profile.mail || profile.userPrincipalName;
      if (!address) throw new Error("Microsoft did not report a mailbox address");
      return { emailAddress: address.toLowerCase() };
    },

    async listInboxDelta({ cursor, since, pageSize = 100 }) {
      const target = cursor
        ? assertGraphUrl(cursor).toString()
        : url(
            `/me/mailFolders/inbox/messages/delta?$select=id,conversationId,from${
              since
                ? `&$filter=${encodeURIComponent(`receivedDateTime ge ${since.toISOString()}`)}`
                : ""
            }`,
          );
      const response = await request("GET", target, {
        headers: { prefer: `IdType="ImmutableId", odata.maxpagesize=${pageSize}` },
      });
      const page = deltaPageSchema.parse(await response.json());
      for (const link of [page["@odata.nextLink"], page["@odata.deltaLink"]]) {
        if (link) assertGraphUrl(link);
      }
      return {
        messages: page.value
          .filter((m) => m["@removed"] === undefined)
          .map((m) => ({
            id: m.id,
            conversationId: m.conversationId ?? null,
            fromAddress: m.from?.emailAddress?.address?.toLowerCase() ?? null,
          })),
        nextLink: page["@odata.nextLink"],
        deltaLink: page["@odata.deltaLink"],
      };
    },

    async getRaw(id) {
      const response = await request(
        "GET",
        url(`/me/messages/${encodeURIComponent(id)}/$value`),
        { headers: { accept: "message/rfc822, text/plain, */*" } },
      );
      return { id, raw: Buffer.from(await response.arrayBuffer()) };
    },

    async send() {
      // Graph cannot send a prebuilt MIME message with a fixed Message-ID; the
      // adapter always uses sendStructured for Outlook.
      throw new GraphApiError(400, "raw_mime_unsupported");
    },

    async sendStructured({ to, subject, body, rfcMessageId }) {
      // A draft left by an earlier interrupted attempt is reused, so a retry
      // never leaves two drafts of the same action.
      const existing = await findInFolder("drafts", rfcMessageId);
      let draft: { id: string; threadId: string };
      if (existing) {
        draft = existing;
      } else {
        const created = await request("POST", url("/me/messages"), {
          body: {
            subject,
            body: { contentType: "text", content: body },
            toRecipients: [{ emailAddress: { address: to } }],
            internetMessageId: rfcMessageId,
          },
        });
        const parsed = messageRefSchema.parse(await created.json());
        draft = { id: parsed.id, threadId: parsed.conversationId ?? "" };
      }
      await request("POST", url(`/me/messages/${encodeURIComponent(draft.id)}/send`));
      return draft;
    },

    async findSentByRfcMessageId(rfcId) {
      // Matched on Message-ID only. A looser subject/recipient match could
      // confirm an earlier email as this one, so a miss stays "unknown".
      return findInFolder("sentitems", rfcId);
    },
  };
}
