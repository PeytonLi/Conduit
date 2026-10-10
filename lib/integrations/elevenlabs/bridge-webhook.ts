import { createHash } from "node:crypto";
import { z } from "zod";
import type { VoiceStore } from "@/lib/db/voice-store";
import { normalizeInitiationFailure } from "./outcomes";
import { verifyHmacSignature } from "./signature";

export const bridgeCallStatusSchema = z
  .object({
    type: z.literal("call_status"),
    action_id: z.guid(),
    call_sid: z.string().trim().min(1).max(200),
    call_status: z.enum(["no-answer", "busy", "failed", "canceled", "completed"]),
    sip_response_code: z.number().int().min(100).max(999).optional(),
    reason: z.string().trim().max(500).optional(),
    occurred_at: z.iso.datetime({ offset: true }),
  })
  .strict();

export interface VoiceBridgeWebhookDeps {
  store: VoiceStore;
  secret: string | undefined;
  now: () => Date;
}

export interface BridgeWebhookResponse {
  status: number;
  body: Record<string, unknown>;
}

function failureReason(status: z.infer<typeof bridgeCallStatusSchema>["call_status"]): string {
  return status === "no-answer" ? "no-answer" : status === "busy" ? "busy" : "initiation_failed";
}

export async function handleVoiceBridgeWebhook(
  rawBody: string,
  signatureHeader: string | null,
  deps: VoiceBridgeWebhookDeps,
): Promise<BridgeWebhookResponse> {
  if (!deps.secret) return { status: 503, body: { ok: false, code: "not_configured" } };
  const check = verifyHmacSignature(rawBody, signatureHeader, deps.secret, deps.now().getTime());
  if (!check.ok) return { status: 401, body: { ok: false, code: check.reason } };

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { ok: false, code: "invalid_json" } };
  }
  const payload = bridgeCallStatusSchema.safeParse(json);
  if (!payload.success) return { status: 400, body: { ok: false, code: "invalid_payload" } };

  const event = payload.data;
  const mappedFailureReason = failureReason(event.call_status);
  const normalized = normalizeInitiationFailure({
    failure_reason: mappedFailureReason,
    sip_status_code: event.sip_response_code ?? null,
  });
  const outcome = {
    ...normalized,
    detail: {
      ...normalized.detail,
      failure_reason: event.reason ?? mappedFailureReason,
    },
  };
  const result = await deps.store.recordCallback({
    provider: "voice_bridge",
    external_event_key: `call_status:${event.call_sid}`,
    conversation_id: event.call_sid,
    event_type: event.type,
    payload_hash: createHash("sha256").update(rawBody, "utf8").digest("hex"),
    payload: json,
    received_at: deps.now().toISOString(),
    action_hint: event.action_id,
    outcome,
    excerpt: event.reason ? `Bridge status reason (untrusted): ${event.reason}` : null,
    provider_call_id: event.call_sid,
    duration_seconds: null,
  });

  if (result.status === "duplicate") {
    return { status: 200, body: { ok: true, status: "duplicate", receipt_id: result.receipt_id } };
  }
  if (result.status === "quarantined") return { status: 200, body: { ok: true, status: "quarantined" } };
  return {
    status: 200,
    body: { ok: true, status: "recorded", receipt_id: result.receipt_id, outcome: outcome.outcome },
  };
}
