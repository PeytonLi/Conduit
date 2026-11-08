import { describe, expect, it } from "vitest";
import type { SyncStore } from "@/lib/integrations/gmail/sync";
import type { OutlookApi, OutlookDeltaPage, OutlookMessageRef } from "@/lib/integrations/outlook/api";
import { GraphApiError } from "@/lib/integrations/outlook/http";
import { syncOutlookConnection } from "@/lib/integrations/outlook/sync";

interface Stored {
  providerMessageId: string;
  providerThreadId: string | null;
  direction: "inbound" | "outbound";
  historical: boolean;
}

function memStore() {
  const s = {
    cursor: null as string | null,
    stored: [] as Stored[],
    statuses: [] as { status: string; code: string | null }[],
    advanceCalls: [] as { expected: string | null; next: string }[],
    failOnMessage: undefined as string | undefined,
    async getCursor() {
      return s.cursor;
    },
    async storeMessage(m: Stored & { raw: Buffer }) {
      if (s.failOnMessage === m.providerMessageId) throw new Error("store boom");
      if (s.stored.some((x) => x.providerMessageId === m.providerMessageId)) return false;
      s.stored.push({
        providerMessageId: m.providerMessageId,
        providerThreadId: m.providerThreadId,
        direction: m.direction,
        historical: m.historical,
      });
      return true;
    },
    async setStatus(_o: string, _c: string, status: string, code: string | null) {
      s.statuses.push({ status, code });
    },
    async advanceCursor(_o: string, _c: string, expected: string | null, next: string) {
      s.advanceCalls.push({ expected, next });
      s.cursor = next;
      return true;
    },
  };
  return s as typeof s & SyncStore;
}

const ref = (id: string, from: string | null = "supplier@bay.example"): OutlookMessageRef => ({
  id,
  conversationId: `conv-${id}`,
  fromAddress: from,
});

type ListArgs = Parameters<OutlookApi["listInboxDelta"]>[0];

function fakeApi(
  pages: OutlookDeltaPage[],
  over: { list?: (args: ListArgs, call: number) => Promise<OutlookDeltaPage> } = {},
) {
  const listCalls: ListArgs[] = [];
  const fetched: string[] = [];
  let n = 0;
  const api: OutlookApi = {
    async getProfile() {
      return { emailAddress: "buyer@harbor.example" };
    },
    async listInboxDelta(args) {
      listCalls.push(args);
      const call = n++;
      if (over.list) return over.list(args, call);
      return pages[Math.min(call, pages.length - 1)];
    },
    async getRaw(id) {
      fetched.push(id);
      return { id, raw: Buffer.from(`raw-${id}`) };
    },
    async send() {
      throw new Error("not used");
    },
    async findSentByRfcMessageId() {
      return null;
    },
  };
  return { api, listCalls, fetched };
}

const DELTA = (token: string) => `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=${token}`;
const NEXT = (page: string) => `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=${page}`;

const base = {
  orgId: "o1",
  connectionId: "c1",
  mailboxAddress: "buyer@harbor.example",
  now: () => new Date("2026-11-08T20:00:00Z"),
};

describe("Outlook sync", () => {
  it("imports a first listing as historical, bounded to the window, and stores the delta link", async () => {
    const store = memStore();
    const { api, listCalls } = fakeApi([
      { messages: [ref("m1"), ref("m2")], nextLink: NEXT("p2") },
      { messages: [ref("m3")], deltaLink: DELTA("d1") },
    ]);
    const result = await syncOutlookConnection({ ...base, api, store });

    expect(result).toMatchObject({ ok: true, stored: 3, duplicates: 0, cursor: DELTA("d1") });
    expect(store.stored.every((m) => m.historical && m.direction === "inbound")).toBe(true);
    expect(store.stored[0].providerThreadId).toBe("conv-m1");
    expect(store.advanceCalls).toEqual([{ expected: null, next: DELTA("d1") }]);
    expect(listCalls[0].since).toEqual(new Date("2026-11-01T20:00:00Z"));
    expect(listCalls[1]).toMatchObject({ cursor: NEXT("p2") });
    expect(listCalls[1].since).toBeUndefined();
  });

  it("resumes from the delta link and treats new mail as live, not historical", async () => {
    const store = memStore();
    store.cursor = DELTA("d1");
    const { api, listCalls } = fakeApi([{ messages: [ref("m9")], deltaLink: DELTA("d2") }]);
    const result = await syncOutlookConnection({ ...base, api, store });

    expect(result.cursor).toBe(DELTA("d2"));
    expect(store.stored).toEqual([
      { providerMessageId: "m9", providerThreadId: "conv-m9", direction: "inbound", historical: false },
    ]);
    expect(listCalls[0]).toEqual({ cursor: DELTA("d1"), since: undefined, pageSize: 100 });
    expect(store.advanceCalls).toEqual([{ expected: DELTA("d1"), next: DELTA("d2") }]);
  });

  it("dedupes messages already stored", async () => {
    const store = memStore();
    store.cursor = DELTA("d1");
    const { api } = fakeApi([{ messages: [ref("m1"), ref("m1")], deltaLink: DELTA("d2") }]);
    const result = await syncOutlookConnection({ ...base, api, store });
    expect(result).toMatchObject({ stored: 1, duplicates: 1 });
  });

  it("records the mailbox's own messages as outbound and historical", async () => {
    const store = memStore();
    store.cursor = DELTA("d1");
    const { api } = fakeApi([
      {
        messages: [ref("mine", "Buyer@Harbor.Example"), ref("theirs")],
        deltaLink: DELTA("d2"),
      },
    ]);
    await syncOutlookConnection({ ...base, api, store });
    expect(store.stored).toEqual([
      expect.objectContaining({ providerMessageId: "mine", direction: "outbound", historical: true }),
      expect.objectContaining({ providerMessageId: "theirs", direction: "inbound", historical: false }),
    ]);
  });

  it("does not advance the cursor when the page cap is hit, and a rerun dedupes", async () => {
    const store = memStore();
    store.cursor = DELTA("d1");
    const endless = fakeApi([], {
      list: async (_args, call) => ({ messages: [ref(`m${call}`)], nextLink: NEXT(`p${call}`) }),
    });
    const capped = await syncOutlookConnection({ ...base, api: endless.api, store, maxPages: 3 });
    expect(capped).toMatchObject({ ok: true, stored: 3, cursor: DELTA("d1") });
    expect(store.advanceCalls).toHaveLength(0);
    expect(store.cursor).toBe(DELTA("d1"));

    const finishing = fakeApi([
      { messages: [ref("m0"), ref("m1"), ref("m2")], deltaLink: DELTA("d2") },
    ]);
    const rerun = await syncOutlookConnection({ ...base, api: finishing.api, store });
    expect(rerun).toMatchObject({ stored: 0, duplicates: 3, cursor: DELTA("d2") });
  });

  it("leaves the cursor untouched when storing fails, then recovers", async () => {
    const store = memStore();
    store.cursor = DELTA("d1");
    store.failOnMessage = "m2";
    const failing = fakeApi([{ messages: [ref("m1"), ref("m2")], deltaLink: DELTA("d2") }]);
    await expect(syncOutlookConnection({ ...base, api: failing.api, store })).rejects.toThrow("store boom");
    expect(store.advanceCalls).toHaveLength(0);
    expect(store.statuses).toHaveLength(0);

    store.failOnMessage = undefined;
    const ok = fakeApi([{ messages: [ref("m1"), ref("m2")], deltaLink: DELTA("d2") }]);
    const rerun = await syncOutlookConnection({ ...base, api: ok.api, store });
    expect(rerun).toMatchObject({ stored: 1, duplicates: 1, cursor: DELTA("d2") });
  });

  it("falls back to a bounded resync when Graph no longer knows the delta link", async () => {
    const store = memStore();
    store.cursor = DELTA("old");
    const { api, listCalls } = fakeApi([], {
      list: async (args) => {
        if (args.cursor) throw new GraphApiError(410, "syncStateNotFound");
        return { messages: [ref("m1")], deltaLink: DELTA("fresh") };
      },
    });
    const result = await syncOutlookConnection({ ...base, api, store });

    expect(result).toMatchObject({ ok: true, stored: 1, cursor: DELTA("fresh") });
    expect(listCalls[1].since).toEqual(new Date("2026-11-01T20:00:00Z"));
    // A resync is not an initial connect: what it finds is live.
    expect(store.stored[0].historical).toBe(false);
    expect(store.advanceCalls).toEqual([{ expected: DELTA("old"), next: DELTA("fresh") }]);
  });

  it.each([
    [new GraphApiError(400, "invalid_grant"), "revoked", "invalid_grant"],
    [new GraphApiError(401, "InvalidAuthenticationToken"), "expired", "expired"],
    [new GraphApiError(429, "ApplicationThrottled"), "degraded", "rate_limited"],
    [new GraphApiError(503, null), "degraded", "transient"],
    [new TypeError("fetch failed"), "degraded", "transient"],
  ])("marks the connection %#", async (error, status, code) => {
    const store = memStore();
    store.cursor = DELTA("d1");
    const { api } = fakeApi([], {
      list: async () => {
        throw error;
      },
    });
    const result = await syncOutlookConnection({ ...base, api, store });
    expect(result).toMatchObject({ ok: false, status });
    expect(store.statuses).toEqual([{ status, code }]);
    expect(store.advanceCalls).toHaveLength(0);
  });

  it("does not advance when Graph returns no delta link", async () => {
    const store = memStore();
    store.cursor = DELTA("d1");
    const { api } = fakeApi([{ messages: [ref("m1")] }]);
    const result = await syncOutlookConnection({ ...base, api, store });
    expect(result.cursor).toBe(DELTA("d1"));
    expect(store.advanceCalls).toHaveLength(0);
  });
});
