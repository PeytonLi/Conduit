import { describe, expect, it, vi } from "vitest";

// gmail/register.ts pulls in lib/db/service which is server-only; stub it so
// the adapter-routing test can import the registration module.
vi.mock("server-only", () => ({}));

import {
  createSupplierEmailAdapter,
  renderSupplierEmail,
  type ContactRecord,
  type SupplierEmailPayload,
} from "@/lib/integrations/gmail/outbound";
import type { GmailApi } from "@/lib/integrations/gmail/api";
import { createReplayTransport } from "@/lib/integrations/gmail/replay";
import type { ActionRecord } from "@/lib/actions/types";

const CONTACT: ContactRecord = {
  normalized_address: "alyssa@baycarton.example.com",
  outreach_approved_at: "2026-01-01T00:00:00Z",
  permitted_channels: ["email"],
  supplier_id: "s1",
};

const payload = (over: Partial<SupplierEmailPayload> = {}): SupplierEmailPayload => ({
  template: "quote_request",
  connection_id: "00000000-0000-4000-8000-0000000000aa",
  contact_id: "00000000-0000-4000-8000-0000000000bb",
  to: "alyssa@baycarton.example.com",
  subject: "Quote needed",
  thread: null,
  facts: {
    item_sku: "CARTON-302015",
    item_description: "Shipping carton",
    specification: { length_mm: 300 },
    quantity: 600,
    unit: "carton",
    destination_name: "Main Warehouse",
    needed_by_local: "2026-10-20",
    quote_fields: ["unit_price", "freight"],
  },
  question: "Can you confirm?",
  ...over,
});

const action = (over: Partial<ActionRecord> = {}): ActionRecord => ({
  id: "act-1",
  orgId: "org-1",
  caseId: "case-1",
  kind: "supplier_email",
  idempotencyKey: "k1",
  payloadHash: "h",
  payload: payload(),
  providerRef: null,
  mode: "live",
  ...over,
});

function fakeGmail(over: Partial<GmailApi> = {}): GmailApi & {
  sends: { raw: string; threadId?: string }[];
} {
  const sends: { raw: string; threadId?: string }[] = [];
  return {
    sends,
    async getProfile() {
      return { emailAddress: "us@harbor.example", historyId: "9" };
    },
    async listMessages() {
      return { ids: [] };
    },
    async listHistory({ startHistoryId }) {
      return { messageIds: [], historyId: startHistoryId };
    },
    async getRaw(id) {
      return { id, threadId: "", labelIds: [], internalDate: 0, raw: Buffer.alloc(0) };
    },
    async send({ raw, threadId }) {
      sends.push({ raw, threadId });
      return { id: "gmail-msg-1", threadId: threadId ?? "t1" };
    },
    async findSentByRfcMessageId() {
      return null;
    },
    ...over,
  };
}

function adapter(over: {
  gmail?: GmailApi;
  contact?: ContactRecord | null;
  appEnv?: "replay" | "sandbox" | "live";
}) {
  const gmail = over.gmail ?? fakeGmail();
  const replay = createReplayTransport();
  const a = createSupplierEmailAdapter({
    appEnv: () => over.appEnv ?? "live",
    transportFor: () => gmail,
    loadContact: async () => (over.contact === undefined ? CONTACT : over.contact),
    fromAddressFor: () => "ops@harbor.example",
    replayTransport: replay,
  });
  return { a, gmail: gmail as ReturnType<typeof fakeGmail>, replay };
}

describe("AT-13 supplier email adapter", () => {
  it("AT-13 sends to the approved contact with threading headers", async () => {
    const { a, gmail } = adapter({});
    const act = action({
      payload: payload({
        subject: "Re: Delivery",
        thread: {
          provider_thread_id: "thread-1",
          in_reply_to: "<orig@bay.example>",
          references: ["<root@bay.example>"],
        },
      }),
    });
    const r = await a.dispatch(act);
    expect(r.outcome).toBe("submitted");
    expect(gmail.sends).toHaveLength(1);
    const mime = gmail.sends[0].raw;
    expect(mime).toContain("To: alyssa@baycarton.example.com");
    expect(mime).toContain("In-Reply-To: <orig@bay.example>");
    expect(mime).toContain("References: <root@bay.example> <orig@bay.example>");
    expect(mime).toContain("Message-ID: <conduit.act-1@harbor.example>");
    expect(mime).not.toMatch(/Subject: Re: Re:/);
    expect(mime).not.toMatch(/^(Cc|Bcc|Reply-To):/m);
  });

  it("AT-13 does not double a Re: subject prefix", () => {
    const { mime } = renderSupplierEmail(
      payload({ subject: "Re: Already", thread: { provider_thread_id: "t", in_reply_to: "<x>", references: [] } }),
      action(),
      { fromAddress: "ops@harbor.example", domain: "harbor.example" },
    );
    expect(mime).toContain("Subject: Re: Already");
  });

  it("AT-13 dispatches only once across repeat calls", async () => {
    const { a, gmail } = adapter({});
    await a.dispatch(action());
    const second = await a.dispatch(action({ providerRef: "gmail-msg-1" }));
    expect(gmail.sends).toHaveLength(1);
    expect(second.outcome).toBe("unknown"); // findResult with no sent copy
  });

  it("AT-13 providerRef set maps through findResult without sending", async () => {
    const gmail = fakeGmail({
      async findSentByRfcMessageId() {
        return { id: "sent-1", threadId: "t" };
      },
    });
    const { a } = adapter({ gmail });
    const r = await a.dispatch(action({ providerRef: "sent-1" }));
    expect(r.outcome).toBe("confirmed");
    expect(gmail.sends).toHaveLength(0);
  });

  it("AT-13 pre-send Sent lookup confirms without sending", async () => {
    const gmail = fakeGmail({
      async findSentByRfcMessageId() {
        return { id: "pre-1", threadId: "t" };
      },
    });
    const { a } = adapter({ gmail });
    const r = await a.dispatch(action());
    expect(r.outcome).toBe("confirmed");
    expect(gmail.sends).toHaveLength(0);
  });

  it("AT-13 blocks an unapproved Reply-To-derived recipient", async () => {
    const { a, gmail } = adapter({});
    const r = await a.dispatch(
      action({ payload: payload({ to: "attacker@evil.example" }) }),
    );
    expect(r.outcome).toBe("failed");
    expect(r.safeSummary).toContain("recipient_not_approved");
    expect(gmail.sends).toHaveLength(0);
  });

  it("AT-13 fails when contact is not outreach-approved", async () => {
    const { a, gmail } = adapter({
      contact: { ...CONTACT, outreach_approved_at: null },
    });
    expect((await a.dispatch(action())).outcome).toBe("failed");
    expect(gmail.sends).toHaveLength(0);
  });

  it("AT-13 strips CRLF header injection from rendered values", () => {
    const { mime } = renderSupplierEmail(
      payload({ subject: "hi\r\nBcc: evil@x.example" }),
      action(),
      { fromAddress: "ops@harbor.example", domain: "harbor.example" },
    );
    // Injection must not create a header line; sanitized text stays on Subject.
    expect(mime).not.toMatch(/\r?\nBcc:/);
    expect(mime).toContain("Subject: hi Bcc: evil@x.example");
  });

  it("AT-13 maps network timeout to unknown, never failed", async () => {
    const gmail = fakeGmail({
      async send() {
        throw new Error("ETIMEDOUT");
      },
    });
    const { a } = adapter({ gmail });
    const r = await a.dispatch(action());
    expect(r.outcome).toBe("unknown");
  });

  it("AT-13 findResult returns unknown (not failed) when not found", async () => {
    const { a } = adapter({});
    const r = await a.findResult(action({ providerRef: "x" }));
    expect(r.outcome).toBe("unknown");
  });

  it("AT-13 replay dispatch is idempotent: second dispatch confirms, one send", async () => {
    const { a, replay } = adapter({ appEnv: "replay" });
    const first = await a.dispatch(action({ providerRef: null }));
    expect(first.outcome).toBe("submitted");
    const second = await a.dispatch(action({ providerRef: null }));
    expect(second.outcome).toBe("confirmed");
    expect(replay.sent).toHaveLength(1);
    const found = await a.findResult(action({ providerRef: "replay:act-1" }));
    expect(found.outcome).toBe("confirmed");
    expect(replay.sent).toHaveLength(1);
  });

  it("AT-13 replay mode performs zero calls to the real transport", async () => {
    const gmail = fakeGmail();
    const { a, replay } = adapter({ gmail, appEnv: "replay" });
    const r = await a.dispatch(action({ mode: "live" }));
    expect(gmail.sends).toHaveLength(0);
    expect(replay.sent).toHaveLength(1);
    expect(r.safeSummary).toContain("replay");
    const r2 = await adapter({ gmail }).a.dispatch(action({ mode: "replay" }));
    expect(gmail.sends).toHaveLength(0);
    expect(r2.providerRef).toBe("replay:act-1");
  });
});

describe("adapter routing with F5", () => {
  it("replay actions resolve to F5's replay adapter; sandbox to ours", async () => {
    const { registerF5Adapters } = await import("@/lib/actions/adapters/index");
    const { resolveAdapterForMode } = await import("@/lib/actions/dispatcher");
    const { isReplayAdapter } = await import("@/lib/actions/replay");
    // Registration is import-lazy: no env/DB is touched here.
    await import("@/lib/integrations/gmail/register");
    registerF5Adapters({
      rpc: async () => null,
      clock: { now: () => new Date("2026-10-12T15:00:00Z") },
    });
    const replay = resolveAdapterForMode("supplier_email", "replay");
    const sandbox = resolveAdapterForMode("supplier_email", "sandbox");
    expect(isReplayAdapter(replay)).toBe(true);
    expect(isReplayAdapter(sandbox)).toBe(false);
    expect(sandbox).not.toBe(replay);
    expect(sandbox.kind).toBe("supplier_email");
  });
});
