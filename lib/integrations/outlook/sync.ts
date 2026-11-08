import { safeErrorLogFields } from "@/lib/safe-error";
import type { SyncResult, SyncStore } from "@/lib/integrations/gmail/sync";
import type { OutlookApi } from "./api";
import { classifyOutlookError } from "./http";

export interface OutlookSyncArgs {
  orgId: string;
  connectionId: string;
  api: OutlookApi;
  store: SyncStore;
  /**
   * The mailbox's own address. Messages from it are recorded as outbound and
   * historical so Conduit never reads its own sent mail as a supplier notice.
   */
  mailboxAddress: string | null;
  now: () => Date;
  windowDays?: number;
  maxPages?: number;
  pageSize?: number;
}

/**
 * Polls one Outlook mailbox through Graph Inbox delta. Same contract as
 * syncGmailConnection: the cursor (a Graph delta link) advances only after
 * every page was stored, a store failure propagates with the cursor untouched,
 * and re-reading a message is harmless because storing dedupes.
 */
export async function syncOutlookConnection(args: OutlookSyncArgs): Promise<SyncResult> {
  const {
    orgId,
    connectionId,
    api,
    store,
    mailboxAddress,
    now,
    windowDays = 7,
    maxPages = 10,
    pageSize = 100,
  } = args;
  const self = mailboxAddress?.toLowerCase() ?? null;
  const cursor = await store.getCursor(orgId, connectionId);

  const storeOne = async (
    ref: { id: string; conversationId: string | null; fromAddress: string | null },
    historical: boolean,
  ): Promise<boolean> => {
    const raw = await api.getRaw(ref.id);
    const outbound = self !== null && ref.fromAddress?.toLowerCase() === self;
    try {
      return await store.storeMessage({
        orgId,
        connectionId,
        providerMessageId: ref.id,
        providerThreadId: ref.conversationId,
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
  };

  /** Reads pages from `start` until Graph returns a delta link. */
  const pull = async (
    start: { cursor?: string; since?: Date },
    historical: boolean,
  ): Promise<SyncResult> => {
    let stored = 0;
    let duplicates = 0;
    let pages = 0;
    let next: string | undefined = start.cursor;
    let deltaLink: string | undefined;
    let first = true;
    do {
      const page = await api.listInboxDelta({
        cursor: next,
        since: first ? start.since : undefined,
        pageSize,
      });
      first = false;
      pages += 1;
      for (const ref of page.messages) {
        if (await storeOne(ref, historical)) stored += 1;
        else duplicates += 1;
      }
      deltaLink = page.deltaLink;
      next = page.nextLink;
      if (next && pages >= maxPages) {
        // Do not advance; the next tick resumes and dedupes.
        return { ok: true, stored, duplicates, cursor };
      }
    } while (next);

    if (!deltaLink) return { ok: true, stored, duplicates, cursor };
    await store.advanceCursor(orgId, connectionId, cursor, deltaLink);
    return { ok: true, stored, duplicates, cursor: deltaLink };
  };

  const windowStart = () => new Date(now().getTime() - windowDays * 24 * 60 * 60 * 1000);

  try {
    if (cursor === null) {
      return await pull({ since: windowStart() }, true); // initial connect: historical
    }
    return await pull({ cursor }, false);
  } catch (err) {
    if ((err as { __storeFailure?: boolean }).__storeFailure) throw err;
    const kind = classifyOutlookError(err);
    console.error("outlook poll failed", { kind, ...safeErrorLogFields(err) });
    switch (kind) {
      case "invalid_cursor":
        return pull({ since: windowStart() }, false); // bounded resync; dedupe protects repeats
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
