import { describe, expect, it } from "vitest";
import {
  gmailPollEnabled,
  syncGmailConnection,
  type SyncStore,
} from "@/lib/integrations/gmail/sync";
import type { GmailApi } from "@/lib/integrations/gmail/api";

function memStore(): SyncStore & {
  cursor: string | null;
  messages: string[];
  statuses: string[];
  advanceCalls: { expected: string | null; next: string }[];
  failOnMessage?: string;
} {
  const s = {
    cursor: null as string | null,
    messages: [] as string[],
    statuses: [] as string[],
    advanceCalls: [] as { expected: string | null; next: string }[],
    failOnMessage: undefined as string | undefined,
    async getCursor() {
      return s.cursor;
    },
    async storeMessage(m: { providerMessageId: string }) {
      if (s.failOnMessage === m.providerMessageId) throw new Error("store boom");
      if (s.messages.includes(m.providerMessageId)) return false;
      s.messages.push(m.providerMessageId);
      return true;
    },
    async setStatus(_o: string, _c: string, status: string) {
      s.statuses.push(status);
    },
    async advanceCursor(_o: string, _c: string, expected: string | null, next: string) {
      s.advanceCalls.push({ expected, next });
      s.cursor = next;
      return true;
    },
  };
  return s;
}

function fakeGmail(pages: { ids: string[]; next?: string }[], over: Partial<GmailApi> = {}): GmailApi {
  let calls = 0;
  return {
    async getProfile() {
      return { emailAddress: "us@x.example", historyId: "H2" };
    },
    async listMessages() {
      const p = pages[Math.min(calls++, pages.length - 1)];
      return { ids: p.ids, nextPageToken: p.next };
    },
    async listHistory() {
      return { messageIds: [], historyId: "H2" };
    },
    async getRaw(id) {
      return { id, threadId: "t" + id, labelIds: [], internalDate: 0, raw: Buffer.from("raw" + id) };
    },
    async send() {
      return { id: "x", threadId: "t" };
    },
    async findSentByRfcMessageId() {
      return null;
    },
    ...over,
  };
}

const base = {
  orgId: "o1",
  connectionId: "c1",
  now: () => new Date("2026-10-12T15:00:00Z"),
};

describe("AT-20 gmail sync", () => {
  it("AT-20 expired cursor triggers bounded full resync with dedupe", async () => {
    const store = memStore();
    store.cursor = "OLD"; // existing cursor that will 404
    const api = fakeGmail(
      [
        { ids: ["m1", "m2"], next: "p2" },
        { ids: ["m2", "m3"] },
      ],
      {
        async listHistory() {
          throw Object.assign(new Error("not found"), { code: 404 });
        },
      },
    );
    const r = await syncGmailConnection({ ...base, api, store });
    expect(r.ok).toBe(true);
    expect(store.messages).toEqual(["m1", "m2", "m3"]);
    expect(r.duplicates).toBe(1); // m2 repeated across pages
    // cursor advanced only after all pages stored
    expect(store.advanceCalls).toEqual([{ expected: "OLD", next: "H2" }]);
    expect(store.cursor).toBe("H2");
  });

  it("AT-20 failure mid-batch does not advance cursor; rerun dedupes", async () => {
    const store = memStore();
    const api = fakeGmail([{ ids: ["m1", "m2"], next: "p2" }, { ids: ["m3"] }]);
    store.failOnMessage = "m3";
    await expect(syncGmailConnection({ ...base, api, store })).rejects.toThrow(
      "store boom",
    );
    expect(store.cursor).toBeNull();
    expect(store.advanceCalls).toHaveLength(0);

    store.failOnMessage = undefined;
    const api2 = fakeGmail([{ ids: ["m1", "m2"], next: "p2" }, { ids: ["m3"] }]);
    const r = await syncGmailConnection({ ...base, api: api2, store });
    expect(r.ok).toBe(true);
    expect(store.messages).toEqual(["m1", "m2", "m3"]);
    expect(r.duplicates).toBe(2);
    expect(store.cursor).toBe("H2");
  });

  it("AT-20 maxPages cap stores fetched messages but does not advance", async () => {
    const store = memStore();
    const api = fakeGmail([
      { ids: ["m1"], next: "p2" },
      { ids: ["m2"], next: "p3" },
    ]);
    const r = await syncGmailConnection({ ...base, api, store, maxPages: 1 });
    expect(r.ok).toBe(true);
    expect(store.messages).toEqual(["m1"]);
    expect(store.advanceCalls).toHaveLength(0);
    expect(store.cursor).toBeNull();
  });
});

describe("AT-22 gmail sync failure statuses", () => {
  it("AT-22 invalid_grant sets revoked, ok:false, cursor unchanged", async () => {
    const store = memStore();
    store.cursor = "C1";
    const api = fakeGmail([], {
      async listHistory() {
        throw new Error("invalid_grant: Token has been revoked");
      },
    });
    const r = await syncGmailConnection({ ...base, api, store });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("revoked");
    expect(store.statuses).toEqual(["revoked"]);
    expect(store.cursor).toBe("C1");
    expect(store.advanceCalls).toHaveLength(0);
  });

  it("AT-22 a 401 sets expired, existing messages retained", async () => {
    const store = memStore();
    store.cursor = "C1";
    store.messages.push("kept-1");
    const api = fakeGmail([], {
      async listHistory() {
        throw Object.assign(new Error("unauthorized"), { code: 401 });
      },
    });
    const r = await syncGmailConnection({ ...base, api, store });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("expired");
    expect(store.cursor).toBe("C1");
    expect(store.messages).toEqual(["kept-1"]);
  });
});

describe("gmailPollEnabled", () => {
  const full = {
    APP_ENV: "live",
    GOOGLE_CLIENT_ID: "id",
    GOOGLE_CLIENT_SECRET: "secret",
    GOOGLE_REDIRECT_URI: "https://x.example/cb",
    CREDENTIAL_ENCRYPTION_KEY: "k",
  };
  it("is false in replay env and true when fully configured", () => {
    expect(gmailPollEnabled({ ...full, APP_ENV: "replay" })).toBe(false);
    expect(gmailPollEnabled(full)).toBe(true);
    expect(gmailPollEnabled({ ...full, APP_ENV: "sandbox" })).toBe(true);
  });
  it("is false when any required env var is missing", () => {
    for (const key of [
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "GOOGLE_REDIRECT_URI",
      "CREDENTIAL_ENCRYPTION_KEY",
    ] as const) {
      expect(gmailPollEnabled({ ...full, [key]: undefined })).toBe(false);
    }
  });
});
