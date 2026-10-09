import { classifyGmailError, type GmailApi } from "./api";

export interface SyncStore {
  getCursor(orgId: string, connectionId: string): Promise<string | null>;
  /** Returns true when the message was newly inserted. */
  storeMessage(args: {
    orgId: string;
    connectionId: string;
    providerMessageId: string;
    providerThreadId: string | null;
    raw: Buffer;
    direction: "inbound" | "outbound";
    historical: boolean;
  }): Promise<boolean>;
  setStatus(
    orgId: string,
    connectionId: string,
    status: "revoked" | "expired" | "degraded" | "healthy",
    errorCode: string | null,
  ): Promise<void>;
  /** Compare-and-swap; returns true if the cursor was advanced. */
  advanceCursor(
    orgId: string,
    connectionId: string,
    expected: string | null,
    next: string,
  ): Promise<boolean>;
}

export interface GmailPollEnv {
  APP_ENV?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
  CREDENTIAL_ENCRYPTION_KEY?: string;
}

/** The gmail poll never runs in replay and requires full OAuth config. */
export function gmailPollEnabled(env: GmailPollEnv): boolean {
  if (env.APP_ENV === "replay") return false;
  return Boolean(
    env.GOOGLE_CLIENT_ID &&
      env.GOOGLE_CLIENT_SECRET &&
      env.GOOGLE_REDIRECT_URI &&
      env.CREDENTIAL_ENCRYPTION_KEY,
  );
}

export interface SyncResult {
  ok: boolean;
  stored: number;
  duplicates: number;
  cursor: string | null;
  status?: "revoked" | "expired" | "degraded";
}

export interface SyncArgs {
  orgId: string;
  connectionId: string;
  api: GmailApi;
  store: SyncStore;
  now: () => Date;
  windowDays?: number;
  maxPages?: number;
  pageSize?: number;
}

export async function syncGmailConnection(args: SyncArgs): Promise<SyncResult> {
  const {
    orgId,
    connectionId,
    api,
    store,
    now,
    windowDays = 7,
    maxPages = 10,
    pageSize = 100,
  } = args;
  void now;

  const cursor = await store.getCursor(orgId, connectionId);

  const storeRaw = async (
    raw: { id: string; threadId: string; labelIds: string[]; raw: Buffer },
    historical: boolean,
  ): Promise<boolean> => {
    const outbound = raw.labelIds.includes("SENT");
    let result: boolean;
    try {
      result = await store.storeMessage({
      orgId,
      connectionId,
      providerMessageId: raw.id,
      providerThreadId: raw.threadId || null,
      raw: raw.raw,
        direction: outbound ? "outbound" : "inbound",
        historical: outbound ? true : historical,
      });
    } catch (err) {
      // A store failure is not a provider failure: propagate so the caller
      // retries; the cursor is intentionally left untouched.
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), {
        __storeFailure: true,
      });
    }
    return result;
  };

  const fullResync = async (historical: boolean): Promise<SyncResult> => {
    let stored = 0;
    let duplicates = 0;
    const profile = await api.getProfile(); // capture BEFORE listing
    let pageToken: string | undefined;
    let pages = 0;
    let capped = false;
    do {
      const page = await api.listMessages({
        q: `newer_than:${windowDays}d`,
        pageToken,
        maxResults: pageSize,
      });
      pages += 1;
      for (const id of page.ids) {
        const raw = await api.getRaw(id);
        const inserted = await storeRaw(raw, historical);
        if (inserted) stored += 1;
        else duplicates += 1;
      }
      pageToken = page.nextPageToken;
      if (pageToken && pages >= maxPages) {
        capped = true;
        break;
      }
    } while (pageToken);

    if (capped) {
      // Do not advance; the next tick resumes and dedupes.
      return { ok: true, stored, duplicates, cursor };
    }
    await store.advanceCursor(orgId, connectionId, cursor, profile.historyId);
    return { ok: true, stored, duplicates, cursor: profile.historyId };
  };

  try {
    if (cursor === null) {
      return await fullResync(true); // initial connect: historical
    }

    // Partial sync via history.list
    let stored = 0;
    let duplicates = 0;
    let pageToken: string | undefined;
    let pages = 0;
    let lastHistoryId = cursor;
    do {
      const page = await api.listHistory({ startHistoryId: cursor, pageToken });
      pages += 1;
      lastHistoryId = page.historyId;
      for (const id of page.messageIds) {
        const raw = await api.getRaw(id);
        const inserted = await storeRaw(raw, false);
        if (inserted) stored += 1;
        else duplicates += 1;
      }
      pageToken = page.nextPageToken;
    } while (pageToken && pages < maxPages);

    if (pageToken) {
      // Cap hit: fetched messages stored, cursor NOT advanced; next tick resumes.
      return { ok: true, stored, duplicates, cursor };
    }
    await store.advanceCursor(orgId, connectionId, cursor, lastHistoryId);
    return { ok: true, stored, duplicates, cursor: lastHistoryId };
  } catch (err) {
    if ((err as { __storeFailure?: boolean }).__storeFailure) throw err;
    const kind = classifyGmailError(err);
    switch (kind) {
      case "invalid_cursor":
        return fullResync(false); // bounded full resync; dedupe protects repeats
      case "revoked":
        await store.setStatus(orgId, connectionId, "revoked", "invalid_grant");
        return { ok: false, stored: 0, duplicates: 0, cursor, status: "revoked" };
      case "expired":
        await store.setStatus(orgId, connectionId, "expired", "expired");
        return { ok: false, stored: 0, duplicates: 0, cursor, status: "expired" };
      default:
        await store.setStatus(orgId, connectionId, "degraded", kind);
        return { ok: false, stored: 0, duplicates: 0, cursor, status: "degraded" };
    }
  }
}
