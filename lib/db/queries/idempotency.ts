import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/db/service";
import { QueryError } from "./client";

export interface StoredResult<T = unknown> {
  status: number;
  body: T;
  replayed: boolean;
}

export interface IdempotencyDeps {
  client?: SupabaseClient;
  actorUserId?: string;
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function requestHash(route: string, body: unknown): string {
  return createHash("sha256").update(route).update(canonicalize(body)).digest("hex");
}

export function sameOriginAllowed(request: Request): boolean {
  const originHeader = request.headers.get("Origin");
  if (!originHeader) return true;
  const host = request.headers.get("Host");
  if (!host) return false;
  try {
    const origin = new URL(originHeader);
    return (
      (origin.protocol === "http:" || origin.protocol === "https:") &&
      origin.host.toLowerCase() === host.toLowerCase() &&
      origin.pathname === "/" &&
      !origin.search &&
      !origin.hash
    );
  } catch {
    return false;
  }
}

export async function withIdempotency<T>(
  orgId: string,
  key: string | null,
  route: string,
  body: unknown,
  fn: () => Promise<{ status: number; body: T }>,
  deps: IdempotencyDeps = {},
): Promise<StoredResult<T>> {
  const normalizedKey = key?.trim();
  if (!normalizedKey) {
    throw new QueryError("idempotency_key_required", 422, "Idempotency-Key is required");
  }

  const client = deps.client ?? createServiceClient();
  const hash = requestHash(route, body);
  const reservation = await (client as SupabaseClient)
    .from("request_idempotency")
    .insert({
      org_id: orgId,
      idempotency_key: normalizedKey,
      route,
      request_hash: hash,
      response_status: 102,
      response_body: {},
      actor_user_id: deps.actorUserId ?? null,
    });

  if (reservation.error && reservation.error.code !== "23505") {
    throw new QueryError("idempotency_unavailable", 503, "Request deduplication is unavailable");
  }

  if (reservation.error?.code === "23505") {
    const existing = await (client as SupabaseClient)
      .from("request_idempotency")
      .select("route,request_hash,response_status,response_body")
      .eq("org_id", orgId)
      .eq("idempotency_key", normalizedKey)
      .maybeSingle();
    if (existing.error || !existing.data) {
      throw new QueryError("idempotency_unavailable", 503, "Request deduplication is unavailable");
    }
    if (existing.data.route !== route || existing.data.request_hash !== hash) {
      throw new QueryError("idempotency_conflict", 409, "Idempotency-Key was already used for another request");
    }
    if (existing.data.response_status === 102) {
      throw new QueryError("idempotency_in_progress", 409, "A request with this key is still in progress");
    }
    return {
      status: existing.data.response_status,
      body: existing.data.response_body as T,
      replayed: true,
    };
  }

  let result: { status: number; body: T };
  try {
    result = await fn();
  } catch (error) {
    await (client as SupabaseClient)
      .from("request_idempotency")
      .delete()
      .eq("org_id", orgId)
      .eq("idempotency_key", normalizedKey)
      .eq("request_hash", hash);
    throw error;
  }

  const stored = await (client as SupabaseClient)
    .from("request_idempotency")
    .update({
      response_status: result.status,
      response_body: result.body,
      actor_user_id: deps.actorUserId ?? null,
    })
    .eq("org_id", orgId)
    .eq("idempotency_key", normalizedKey)
    .eq("request_hash", hash);
  if (stored.error) {
    throw new QueryError("idempotency_unavailable", 503, "Request result could not be saved");
  }
  return { ...result, replayed: false };
}

export function newRequestId(): string {
  return randomUUID();
}
