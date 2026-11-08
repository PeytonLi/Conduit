import { describe, expect, it } from "vitest";
import { createGraphOutlookApi } from "@/lib/integrations/outlook/api";
import { GraphApiError } from "@/lib/integrations/outlook/http";

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function graph(handlers: ((call: Call) => Response | undefined)[]) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url,
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
      ),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    for (const handler of handlers) {
      const response = handler(call);
      if (response) return response;
    }
    return new Response(JSON.stringify({ error: { code: "NotFound" } }), { status: 404 });
  };
  const api = createGraphOutlookApi({ getAccessToken: async () => "tok", fetchImpl });
  return { api, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const RFC = "<conduit.act-1@harbor.example>";

describe("Graph Outlook adapter: reading", () => {
  it("reports the mailbox address in lower case", async () => {
    const { api, calls } = graph([
      (c) => (c.url.includes("/me?") ? json({ mail: "Buyer@Harbor.Example" }) : undefined),
    ]);
    await expect(api.getProfile()).resolves.toEqual({ emailAddress: "buyer@harbor.example" });
    expect(calls[0].headers.authorization).toBe("Bearer tok");
  });

  it("falls back to the user principal name and rejects a profile without an address", async () => {
    const upn = graph([() => json({ mail: null, userPrincipalName: "buyer@harbor.example" })]);
    await expect(upn.api.getProfile()).resolves.toEqual({ emailAddress: "buyer@harbor.example" });
    const none = graph([() => json({})]);
    await expect(none.api.getProfile()).rejects.toThrow("mailbox address");
  });

  it("starts a delta listing from a date with immutable ids and a page size", async () => {
    const { api, calls } = graph([
      () =>
        json({
          value: [
            { id: "m1", conversationId: "c1", from: { emailAddress: { address: "Sup@Bay.Example" } } },
            { id: "m2", "@removed": { reason: "deleted" } },
          ],
          "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=t1",
        }),
    ]);
    const page = await api.listInboxDelta({ since: new Date("2026-11-01T00:00:00Z"), pageSize: 50 });
    expect(page.messages).toEqual([
      { id: "m1", conversationId: "c1", fromAddress: "sup@bay.example" },
    ]);
    expect(page.deltaLink).toContain("deltatoken=t1");
    const [call] = calls;
    expect(call.url).toContain("/me/mailFolders/inbox/messages/delta?");
    expect(decodeURIComponent(call.url)).toContain("receivedDateTime ge 2026-11-01T00:00:00.000Z");
    expect(call.headers.prefer).toContain('IdType="ImmutableId"');
    expect(call.headers.prefer).toContain("odata.maxpagesize=50");
  });

  it("resumes from a stored Graph link", async () => {
    const link = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=t1";
    const { api, calls } = graph([() => json({ value: [], "@odata.deltaLink": link })]);
    await api.listInboxDelta({ cursor: link });
    expect(calls[0].url).toBe(link);
  });

  it.each([
    "https://evil.example/steal?$deltatoken=t1",
    "http://graph.microsoft.com/v1.0/me/messages/delta",
    "https://graph.microsoft.com.evil.example/v1.0/me",
    "https://user:pw@graph.microsoft.com/v1.0/me",
    "not a url",
  ])("never sends the bearer token to %s", async (cursor) => {
    const { api, calls } = graph([() => json({ value: [] })]);
    await expect(api.listInboxDelta({ cursor })).rejects.toBeInstanceOf(GraphApiError);
    expect(calls).toHaveLength(0);
  });

  it("rejects a response whose next link points away from Graph", async () => {
    const { api } = graph([
      () => json({ value: [], "@odata.nextLink": "https://evil.example/next" }),
    ]);
    await expect(api.listInboxDelta({})).rejects.toBeInstanceOf(GraphApiError);
  });

  it("rejects a malformed delta page at the boundary", async () => {
    const { api } = graph([() => json({ value: [{ nope: true }] })]);
    await expect(api.listInboxDelta({})).rejects.toThrow();
  });

  it("downloads a message as MIME by its encoded id", async () => {
    const { api, calls } = graph([
      (c) =>
        c.url.endsWith("/$value")
          ? new Response("From: a@b.example\r\n\r\nhello", { status: 200 })
          : undefined,
    ]);
    const raw = await api.getRaw("AAMk/+=");
    expect(raw.raw.toString()).toContain("hello");
    expect(calls[0].url).toBe(
      `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent("AAMk/+=")}/$value`,
    );
  });

  it("turns an error response into a status-bearing error with only the provider code", async () => {
    const { api } = graph([
      () => json({ error: { code: "ErrorAccessDenied", message: "private mailbox detail" } }, 403),
    ]);
    const error = await api.getRaw("x").catch((e) => e);
    expect(error).toBeInstanceOf(GraphApiError);
    expect(error).toMatchObject({ status: 403, code: "ErrorAccessDenied" });
    expect(error.message).not.toContain("private mailbox detail");
  });
});

describe("Graph Outlook adapter: sending", () => {
  const send = { to: "alyssa@baycarton.example.com", subject: "Quote", body: "Hello", rfcMessageId: RFC };

  it("creates a draft carrying the Message-ID, then sends that draft", async () => {
    const { api, calls } = graph([
      (c) => (c.url.includes("/mailFolders/drafts/") ? json({ value: [] }) : undefined),
      (c) =>
        c.method === "POST" && c.url.endsWith("/me/messages")
          ? json({ id: "draft-1", conversationId: "conv-1" }, 201)
          : undefined,
      (c) => (c.url.endsWith("/draft-1/send") ? new Response(null, { status: 202 }) : undefined),
    ]);
    const sent = await api.sendStructured!(send);
    expect(sent).toEqual({ id: "draft-1", threadId: "conv-1" });
    const create = calls.find((c) => c.method === "POST" && c.url.endsWith("/me/messages"))!;
    expect(create.body).toEqual({
      subject: "Quote",
      body: { contentType: "text", content: "Hello" },
      toRecipients: [{ emailAddress: { address: "alyssa@baycarton.example.com" } }],
      internetMessageId: RFC,
    });
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "GET /v1.0/me/mailFolders/drafts/messages",
      "POST /v1.0/me/messages",
      "POST /v1.0/me/messages/draft-1/send",
    ]);
  });

  it("reuses a draft left by an interrupted attempt instead of creating another", async () => {
    const { api, calls } = graph([
      (c) =>
        c.url.includes("/mailFolders/drafts/")
          ? json({ value: [{ id: "draft-9", conversationId: "conv-9" }] })
          : undefined,
      (c) => (c.url.endsWith("/draft-9/send") ? new Response(null, { status: 202 }) : undefined),
    ]);
    await expect(api.sendStructured!(send)).resolves.toEqual({ id: "draft-9", threadId: "conv-9" });
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/me/messages"))).toBe(false);
  });

  it("escapes quotes in the Message-ID filter", async () => {
    const { api, calls } = graph([() => json({ value: [] })]);
    await api.findSentByRfcMessageId("<a'b@x.example>");
    expect(decodeURIComponent(calls[0].url)).toContain("internetMessageId eq '<a''b@x.example>'");
  });

  it("finds a sent message only by Message-ID in Sent Items", async () => {
    const hit = graph([
      (c) =>
        c.url.includes("/mailFolders/sentitems/")
          ? json({ value: [{ id: "sent-1", conversationId: "conv-1" }] })
          : undefined,
    ]);
    await expect(hit.api.findSentByRfcMessageId(RFC)).resolves.toEqual({
      id: "sent-1",
      threadId: "conv-1",
    });
    const miss = graph([() => json({ value: [] })]);
    await expect(miss.api.findSentByRfcMessageId(RFC)).resolves.toBeNull();
  });

  it("does not offer raw MIME sending", async () => {
    const { api, calls } = graph([]);
    await expect(api.send({ raw: "x" })).rejects.toBeInstanceOf(GraphApiError);
    expect(calls).toHaveLength(0);
  });

  it("propagates a rejected send so the dispatcher can classify it", async () => {
    const { api } = graph([
      (c) => (c.url.includes("/mailFolders/drafts/") ? json({ value: [] }) : undefined),
      (c) =>
        c.method === "POST" && c.url.endsWith("/me/messages") ? json({ id: "d" }, 201) : undefined,
      (c) => (c.url.endsWith("/d/send") ? json({ error: { code: "ErrorQuotaExceeded" } }, 503) : undefined),
    ]);
    await expect(api.sendStructured!(send)).rejects.toMatchObject({ status: 503 });
  });
});
