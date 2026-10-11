import { describe, expect, it, vi } from "vitest";
import type { ActionRecord } from "@/lib/actions/types";
import { createComposioGmailApi } from "@/lib/integrations/gmail/composio-api";
import type { ComposioGmailClient } from "@/lib/integrations/gmail/composio-client";
import type { GmailApi } from "@/lib/integrations/gmail/api";
import { parseRawEmail } from "@/lib/integrations/gmail/mime";
import {
  createSupplierEmailAdapter,
  type ContactRecord,
  type SupplierEmailPayload,
} from "@/lib/integrations/gmail/outbound";
import { syncGmailConnection } from "@/lib/integrations/gmail/sync";

const payload: SupplierEmailPayload = {
  template: "quote_request",
  connection_id: "00000000-0000-4000-8000-0000000000aa",
  contact_id: "00000000-0000-4000-8000-0000000000bb",
  to: "supplier@example.test",
  subject: "Quote needed",
  thread: null,
  facts: {
    item_sku: "CARTON-302015",
    item_description: "Shipping carton",
    specification: {},
    quantity: 20,
    unit: "carton",
    destination_name: "Main Warehouse",
    needed_by_local: "2026-10-20",
    quote_fields: ["unit_price"],
  },
  question: "",
};

const action: ActionRecord = {
  id: "act-composio-1",
  orgId: "org-1",
  caseId: "case-1",
  kind: "supplier_email",
  idempotencyKey: "key-1",
  payloadHash: "hash-1",
  payload,
  providerRef: null,
  mode: "live",
};

const contact: ContactRecord = {
  normalized_address: "supplier@example.test",
  outreach_approved_at: "2026-01-01T00:00:00Z",
  permitted_channels: ["email"],
  supplier_id: "supplier-1",
};

function fakeClient(
  execute: (slug: string, body: Parameters<ComposioGmailClient["tools"]["execute"]>[1]) => Promise<unknown>,
): ComposioGmailClient {
  return {
    connectedAccounts: {
      link: vi.fn(),
      list: vi.fn(),
      delete: vi.fn(),
    },
    tools: { execute: vi.fn(execute) },
  };
}

const emailTimestamp = "2026-10-12T15:00:00.000Z";
const emailMessage = {
  messageId: "gmail-message-1",
  threadId: "thread-1",
  labelIds: ["INBOX"],
  sender: "Supplier <supplier@example.test>",
  to: "ops@example.test",
  subject: "Availability",
  messageTimestamp: emailTimestamp,
  messageText: "Hello,\r\nWe have stock.",
  payload: {
    headers: [
      { name: "From", value: "Supplier <supplier@example.test>" },
      { name: "To", value: "ops@example.test" },
      { name: "Subject", value: "Availability" },
      { name: "Date", value: emailTimestamp },
      { name: "Message-ID", value: "<msg-1@example.test>" },
    ],
  },
};

describe("Composio Gmail adapter", () => {
  it("fetches and normalizes messages consistently with the Google Gmail seam", async () => {
    const execute = vi.fn(async (slug: string) => {
      if (slug === "GMAIL_FETCH_EMAILS") {
        return {
          successful: true,
          data: { messages: [{ messageId: "gmail-message-1" }], nextPageToken: "" },
        };
      }
      if (slug === "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID") {
        return { successful: true, data: emailMessage };
      }
      throw new Error(`unexpected tool: ${slug}`);
    });
    const composioApi = createComposioGmailApi(fakeClient(execute), "org-1", "ca-1");
    const googleRaw = Buffer.from(
      [
        "From: Supplier <supplier@example.test>",
        "To: ops@example.test",
        "Subject: Availability",
        `Date: ${emailTimestamp}`,
        "Message-ID: <msg-1@example.test>",
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: 8bit",
        "",
        "Hello,",
        "We have stock.",
      ].join("\r\n"),
      "utf8",
    );
    const googleApi: GmailApi = {
      async getProfile() {
        return { emailAddress: "ops@example.test", historyId: "cursor-1" };
      },
      async listMessages() {
        return { ids: ["gmail-message-1"] };
      },
      async listHistory({ startHistoryId }) {
        return { messageIds: [], historyId: startHistoryId };
      },
      async getRaw(id) {
        return {
          id,
          threadId: "thread-1",
          labelIds: ["INBOX"],
          internalDate: Date.parse(emailTimestamp),
          raw: googleRaw,
        };
      },
      async send() {
        return { id: "sent", threadId: "thread-1" };
      },
      async findSentByRfcMessageId() {
        return null;
      },
    };
    const collected = async (api: GmailApi) => {
      const records: { direction: string; parsed: ReturnType<typeof parseRawEmail> }[] = [];
      await syncGmailConnection({
        orgId: "org-1",
        connectionId: "connection-1",
        api,
        now: () => new Date(emailTimestamp),
        store: {
          async getCursor() {
            return null;
          },
          async storeMessage(message) {
            records.push({
              direction: message.direction,
              parsed: parseRawEmail(message.raw),
            });
            return true;
          },
          async setStatus() {},
          async advanceCursor() {
            return true;
          },
        },
      });
      return records;
    };

    const [composioMessages, googleMessages] = await Promise.all([
      collected(composioApi),
      collected(googleApi),
    ]);

    expect(composioMessages).toEqual(googleMessages);
    expect(execute).toHaveBeenCalledWith(
      "GMAIL_FETCH_EMAILS",
      expect.objectContaining({
        userId: "org-1",
        connectedAccountId: "ca-1",
        arguments: expect.objectContaining({ ids_only: true, query: "newer_than:7d" }),
      }),
    );
    expect(execute).toHaveBeenCalledWith(
      "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
      expect.objectContaining({
        arguments: { message_id: "gmail-message-1", format: "raw", user_id: "me" },
      }),
    );
  });

  it("records the provider message id when Composio sends successfully", async () => {
    const execute = async (slug: string) => {
      if (slug === "GMAIL_FETCH_EMAILS") {
        return { successful: true, data: { messages: [], nextPageToken: "" } };
      }
      if (slug === "GMAIL_SEND_EMAIL") {
        return {
          successful: true,
          data: { response_data: { id: "provider-message-1", threadId: "thread-1" } },
        };
      }
      throw new Error(`unexpected tool: ${slug}`);
    };
    const client = fakeClient(execute);
    const api = createComposioGmailApi(client, "org-1", "ca-1");
    const adapter = createSupplierEmailAdapter({
      appEnv: () => "live",
      transportFor: () => api,
      loadContact: async () => contact,
      fromAddressFor: () => "ops@example.test",
      replayTransport: api,
    });

    const result = await adapter.dispatch(action);

    expect(result).toMatchObject({
      outcome: "submitted",
      providerRef: "provider-message-1",
    });
    expect(client.tools.execute).toHaveBeenCalledWith(
      "GMAIL_SEND_EMAIL",
      expect.objectContaining({
        arguments: expect.objectContaining({
          recipient_email: "supplier@example.test",
          body: expect.stringContaining("We are requesting a quote"),
          subject: "Quote needed",
        }),
      }),
    );
  });

  it("uses only live-schema arguments when sending a reply", async () => {
    const client = fakeClient(async (slug) => {
      if (slug === "GMAIL_SEND_EMAIL") {
        return { successful: true, data: { id: "provider-message-2" } };
      }
      throw new Error(`unexpected tool: ${slug}`);
    });
    const api = createComposioGmailApi(client, "org-1", "ca-1");

    await api.sendStructured?.({
      to: "supplier@example.test",
      subject: "Re: Quote needed",
      body: "Following up",
      rfcMessageId: "<reply@example.test>",
      threadId: "thread-1",
    });

    expect(client.tools.execute).toHaveBeenCalledWith(
      "GMAIL_SEND_EMAIL",
      expect.objectContaining({
        arguments: {
          recipient_email: "supplier@example.test",
          subject: "Re: Quote needed",
          body: "Following up",
          is_html: false,
          user_id: "me",
        },
      }),
    );
  });

  it("maps an ambiguous send to unknown and reconciles without resending", async () => {
    let sendCalls = 0;
    const execute = async (slug: string) => {
      if (slug === "GMAIL_FETCH_EMAILS") {
        return { successful: true, data: { messages: [], nextPageToken: "" } };
      }
      if (slug === "GMAIL_SEND_EMAIL") {
        sendCalls += 1;
        throw Object.assign(new Error("connection timed out"), { code: "ETIMEDOUT" });
      }
      throw new Error(`unexpected tool: ${slug}`);
    };
    const api = createComposioGmailApi(fakeClient(execute), "org-1", "ca-1");
    const adapter = createSupplierEmailAdapter({
      appEnv: () => "live",
      transportFor: () => api,
      loadContact: async () => contact,
      fromAddressFor: () => "ops@example.test",
      replayTransport: api,
    });

    const dispatched = await adapter.dispatch(action);
    const reconciled = await adapter.findResult(action);

    expect(dispatched.outcome).toBe("unknown");
    expect(reconciled.outcome).toBe("unknown");
    expect(sendCalls).toBe(1);
  });
});
