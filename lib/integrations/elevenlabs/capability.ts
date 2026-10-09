import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const VOICE_GRANT_TTL_MS = 15 * 60 * 1000;
export const VOICE_TOKEN_HEADER = "x-conduit-voice-token";
export const VOICE_TOKEN_DYNAMIC_VARIABLE = "secret__conduit_voice_token";

export const VOICE_TOOL_NAMES = [
  "read_case_facts",
  "validate_offer",
  "record_provisional_offer",
  "request_written_confirmation",
  "request_human_review",
  "end_call",
] as const;

export type VoiceToolName = (typeof VOICE_TOOL_NAMES)[number];

/** Tools that remain callable while the case is paused, so the call can end cleanly. */
export const VOICE_TOOLS_ALLOWED_WHILE_PAUSED: ReadonlySet<VoiceToolName> = new Set([
  "request_human_review",
  "end_call",
]);

export function isVoiceToolName(value: string): value is VoiceToolName {
  return (VOICE_TOOL_NAMES as readonly string[]).includes(value);
}

export function generateVoiceToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashVoiceToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function tokenHashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}
