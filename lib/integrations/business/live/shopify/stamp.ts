import { createHash } from "node:crypto";

/** Short, stable stamp derived from Conduit's change reference; written onto everything Conduit creates in Shopify. */
export function changeStamp(changeRef: string): string {
  return `CDT-${createHash("sha256").update(changeRef).digest("hex").slice(0, 16)}`;
}

/** Deterministic UUID-shaped idempotency key per change reference and write index. */
export function idempotencyKey(changeRef: string, index: number): string {
  const h = createHash("sha256").update(`${changeRef}:${index}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
