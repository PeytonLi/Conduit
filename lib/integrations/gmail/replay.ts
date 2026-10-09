import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { GmailApi } from "./api";
import { ingestMessage, type IngestResult, type RpcClient } from "@/lib/db/messages";

export const DEFAULT_MESSAGES_DIR = "tests/fixtures/harbor-pack/messages";

/** In-memory replay transport: records sends, never touches a network. */
export function createReplayTransport(): GmailApi & {
  sent: { raw: string; threadId?: string }[];
} {
  const sent: { raw: string; threadId?: string }[] = [];
  return {
    sent,
    async getProfile() {
      return { emailAddress: "replay@conduit.local", historyId: "0" };
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
      sent.push({ raw, threadId });
      return { id: `replay:${sent.length}`, threadId: threadId ?? "" };
    },
    async findSentByRfcMessageId() {
      return null;
    },
  };
}

export function loadReplayMessages(
  dir: string = DEFAULT_MESSAGES_DIR,
): { filename: string; raw: Buffer }[] {
  return readdirSync(/* turbopackIgnore: true */ dir)
    .filter((f) => f.endsWith(".eml"))
    .sort()
    .map((f) => ({
      filename: f,
      raw: readFileSync(/* turbopackIgnore: true */ join(dir, f)),
    }));
}

export async function ingestReplayMessages({
  rpc,
  orgId,
  connectionId,
  files,
  dir = DEFAULT_MESSAGES_DIR,
}: {
  rpc: RpcClient;
  orgId: string;
  connectionId: string;
  files?: string[];
  dir?: string;
}): Promise<IngestResult[]> {
  const all = loadReplayMessages(dir);
  const selected = files ? all.filter((m) => files.includes(m.filename)) : all;
  const results: IngestResult[] = [];
  for (const { filename, raw } of selected) {
    results.push(
      await ingestMessage({
        rpc,
        orgId,
        connectionId,
        providerMessageId: `replay:${filename}`,
        providerThreadId: null,
        raw,
        historical: false,
        direction: "inbound",
      }),
    );
  }
  return results;
}
