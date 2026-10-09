import { createHmac, timingSafeEqual } from "node:crypto";

export const ELEVENLABS_SIGNATURE_HEADER = "elevenlabs-signature";
/** Matches the installed SDK's `webhooks.constructEvent` tolerance (30 minutes). */
export const SIGNATURE_MAX_AGE_SECONDS = 30 * 60;
/** Clock-skew allowance for timestamps slightly in the future. */
export const SIGNATURE_MAX_FUTURE_SECONDS = 5 * 60;

export type SignatureCheck =
  | { ok: true; timestamp: number }
  | { ok: false; reason: "missing_header" | "malformed_header" | "timestamp_out_of_range" | "bad_signature" };

/**
 * Verifies an ElevenLabs webhook signature: header `t=<unix>,v0=<hex>` where
 * hex = HMAC-SHA256(secret, `${t}.${rawBody}`). Must run on the raw, unparsed body.
 */
export function verifyElevenLabsSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  nowMs: number,
): SignatureCheck {
  if (!header) return { ok: false, reason: "missing_header" };
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, ...rest] = part.trim().split("=");
    const value = rest.join("=");
    if (key === "t" && /^\d+$/.test(value)) timestamp = Number(value);
    if (key === "v0" && /^[0-9a-f]{64}$/i.test(value)) signatures.push(value.toLowerCase());
  }
  if (timestamp === null || signatures.length === 0) return { ok: false, reason: "malformed_header" };

  const nowSeconds = Math.floor(nowMs / 1000);
  if (timestamp < nowSeconds - SIGNATURE_MAX_AGE_SECONDS || timestamp > nowSeconds + SIGNATURE_MAX_FUTURE_SECONDS) {
    return { ok: false, reason: "timestamp_out_of_range" };
  }

  const expected = Buffer.from(
    createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex"),
    "hex",
  );
  const matches = signatures.some((candidate) => {
    const given = Buffer.from(candidate, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  return matches ? { ok: true, timestamp } : { ok: false, reason: "bad_signature" };
}

/** Test/replay helper producing a header in the provider's format. */
export function signElevenLabsPayload(rawBody: string, secret: string, timestampSeconds: number): string {
  const digest = createHmac("sha256", secret).update(`${timestampSeconds}.${rawBody}`, "utf8").digest("hex");
  return `t=${timestampSeconds},v0=${digest}`;
}
