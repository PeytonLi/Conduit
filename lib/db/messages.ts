import { createHash } from "node:crypto";
import { parseRawEmail } from "@/lib/integrations/gmail/mime";

export interface RpcClient {
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T>;
}

export class RpcError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.status =
      code === "P0404" ? 404 : code === "P0409" ? 409 : code === "P0422" ? 422 : 500;
  }
}

function rpcErrorCode(err: { code?: string; message?: string }): string {
  if (err.code && /^P0\d{3}$/.test(err.code)) return err.code;
  const m = err.message?.match(/\b(P0\d{3})\b/);
  if (m) return m[1];
  return err.code ?? "P5000";
}

interface SupabaseLike {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{
    data: unknown;
    error: { code?: string; message?: string } | null;
  }>;
}

export function supabaseRpcClient(client: SupabaseLike): RpcClient {
  return {
    async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
      const { data, error } = await client.rpc(fn, { p: args });
      if (error) {
        throw new RpcError(rpcErrorCode(error), error.message ?? "rpc error");
      }
      return data as T;
    },
  };
}

export interface IngestResult {
  source_message_id: string;
  created: boolean;
  processing_state: string;
}

export interface LoadResult {
  message: {
    id: string;
    org_id: string;
    connection_id: string | null;
    provider_message_id: string;
    rfc_message_id: string | null;
    direction: "inbound" | "outbound";
    sender: string | null;
    sent_at: string | null;
    received_at: string | null;
    body_evidence_id: string | null;
    historical: boolean;
    processing_state: string;
  };
  provider: string | null;
  segments: {
    evidence_id: string;
    kind: "body" | "quoted" | "forwarded";
    index: number;
    content: string;
    content_hash: string;
  }[];
  latest_extraction: {
    id: string;
    version: number;
    extractor: string;
    status: string;
    facts: unknown;
    unresolved: unknown;
  } | null;
}

export async function ingestMessage({
  rpc,
  orgId,
  connectionId,
  providerMessageId,
  providerThreadId,
  raw,
  historical,
  direction,
}: {
  rpc: RpcClient;
  orgId: string;
  connectionId: string;
  providerMessageId: string;
  providerThreadId?: string | null;
  raw: Buffer | string;
  historical: boolean;
  direction: "inbound" | "outbound";
}): Promise<IngestResult> {
  const parsed = parseRawEmail(raw);
  const segments = parsed.segments.map((s) => ({
    kind: s.kind,
    index: s.index,
    content: s.content,
    content_hash: createHash("sha256").update(s.content).digest("hex"),
    locator: `segment:${s.index}:${s.kind}`,
  }));
  return rpc.rpc<IngestResult>("inbox_store_message", {
    org_id: orgId,
    connection_id: connectionId,
    provider_message_id: providerMessageId,
    provider_thread_id: providerThreadId ?? null,
    rfc_message_id: parsed.rfcMessageId,
    direction,
    sender: parsed.sender,
    recipients: parsed.recipients,
    sent_at: parsed.sentAt?.toISOString() ?? null,
    received_at: new Date().toISOString(),
    historical,
    body_hash: parsed.bodyHash,
    segments,
    attachments: parsed.attachments,
  });
}

export async function ensureInboxConnection(
  rpc: RpcClient,
  orgId: string,
  provider: "replay_inbox" | "manual_paste",
  externalAccountId?: string,
): Promise<string> {
  const r = await rpc.rpc<{ connection_id: string }>("inbox_ensure_connection", {
    org_id: orgId,
    provider,
    external_account_id: externalAccountId ?? "default",
  });
  return r.connection_id;
}

export async function loadMessage(
  rpc: RpcClient,
  orgId: string,
  sourceMessageId: string,
): Promise<LoadResult> {
  return rpc.rpc<LoadResult>("inbox_load_message", {
    org_id: orgId,
    source_message_id: sourceMessageId,
  });
}
