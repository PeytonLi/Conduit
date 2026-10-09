import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from "node:crypto";

export class CredentialKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialKeyError";
  }
}

export function credentialKeyVersion(key: string): string {
  const idx = key.indexOf(":");
  if (idx === -1) throw new CredentialKeyError("Key must be formatted v1:<base64>");
  return key.slice(0, idx);
}

function keyBytes(key: string, expectedVersion?: string): Buffer {
  const idx = key.indexOf(":");
  if (idx === -1) throw new CredentialKeyError("Key must be formatted v1:<base64>");
  const version = key.slice(0, idx);
  if (expectedVersion !== undefined && version !== expectedVersion) {
    throw new CredentialKeyError(
      `Key version mismatch: expected ${expectedVersion}, got ${version}`,
    );
  }
  const bytes = Buffer.from(key.slice(idx + 1), "base64");
  if (bytes.length !== 32) {
    throw new CredentialKeyError("Credential key must decode to 32 bytes");
  }
  return bytes;
}

export function encryptCredential(plaintext: string, key: string): string {
  const bytes = keyBytes(key);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", bytes, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

export function decryptCredential(b64: string, key: string, keyVersion: string): string {
  const bytes = keyBytes(key, keyVersion);
  const packed = Buffer.from(b64, "base64");
  if (packed.length < 12 + 16) {
    throw new CredentialKeyError("Ciphertext too short");
  }
  const iv = packed.subarray(0, 12);
  const tag = packed.subarray(12, 28);
  const ciphertext = packed.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", bytes, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new CredentialKeyError("Credential decryption failed (tampered or wrong key)");
  }
}

function stateKey(key: string): Buffer {
  const bytes = keyBytes(key);
  return Buffer.from(hkdfSync("sha256", bytes, "gmail-oauth-state", "state-signing", 32));
}

export interface OAuthStatePayload {
  o: string;
  u: string;
  n: string;
  r: string;
  exp: number;
}

export function signState(payload: OAuthStatePayload, key: string): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", stateKey(key)).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyState(
  state: string,
  key: string,
  nowMs: number = Date.now(),
): { ok: true; payload: OAuthStatePayload } | { ok: false; error: "bad_signature" | "expired" | "malformed" } {
  const dot = state.lastIndexOf(".");
  if (dot === -1) return { ok: false, error: "malformed" };
  const body = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const expected = createHmac("sha256", stateKey(key)).update(body).digest();
  const actual = Buffer.from(sig, "base64url");
  if (expected.length !== actual.length || !expected.equals(actual)) {
    return { ok: false, error: "bad_signature" };
  }
  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, error: "malformed" };
  }
  if (typeof payload.exp !== "number" || payload.exp * 1000 < nowMs) {
    return { ok: false, error: "expired" };
  }
  return { ok: true, payload };
}
