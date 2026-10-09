import { google, type Auth } from "googleapis";
import { signState, verifyState } from "./crypto";

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
] as const;

export type StateVerifyError =
  | "bad_signature"
  | "expired"
  | "nonce_mismatch"
  | "user_mismatch"
  | "org_mismatch"
  | "not_owner"
  | "redirect_mismatch"
  | "malformed";

export function buildAuthorizationUrl({
  oauth2,
  orgId,
  userId,
  nonce,
  redirectUri,
  signingKey,
  now,
}: {
  oauth2: Pick<Auth.OAuth2Client, "generateAuthUrl">;
  orgId: string;
  userId: string;
  nonce: string;
  redirectUri: string;
  signingKey: string;
  now: () => Date;
}): string {
  const state = signState(
    { o: orgId, u: userId, n: nonce, r: redirectUri, exp: Math.floor(now().getTime() / 1000) + 600 },
    signingKey,
  );
  return oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [...GMAIL_SCOPES],
    state,
    include_granted_scopes: false,
  });
}

export function verifyCallback({
  state,
  nonceCookie,
  sessionUserId,
  sessionOrgId,
  sessionRole,
  redirectUri,
  signingKey,
  now,
}: {
  state: string;
  nonceCookie: string;
  sessionUserId: string;
  sessionOrgId: string;
  sessionRole: string;
  redirectUri: string;
  signingKey: string;
  now: () => Date;
}):
  | { ok: true; orgId: string; userId: string }
  | { ok: false; error: StateVerifyError } {
  const verified = verifyState(state, signingKey, now().getTime());
  if (!verified.ok) {
    return {
      ok: false,
      error:
        verified.error === "malformed"
          ? "malformed"
          : verified.error === "expired"
            ? "expired"
            : "bad_signature",
    };
  }
  const p = verified.payload;
  // verifyState uses Date.now() internally; re-check expiry against the
  // injected clock for determinism in tests.
  if (p.exp * 1000 < now().getTime()) return { ok: false, error: "expired" };
  if (p.n !== nonceCookie) return { ok: false, error: "nonce_mismatch" };
  if (p.u !== sessionUserId) return { ok: false, error: "user_mismatch" };
  if (p.o !== sessionOrgId) return { ok: false, error: "org_mismatch" };
  if (sessionRole !== "owner") return { ok: false, error: "not_owner" };
  if (p.r !== redirectUri) return { ok: false, error: "redirect_mismatch" };
  return { ok: true, orgId: p.o, userId: p.u };
}

export interface TokenExchangeResult {
  refreshToken: string;
  expiresAt: string | null;
  scopes: string[];
  emailAddress: string;
  historyId: string;
}

export async function exchangeCode(
  oauth2: Auth.OAuth2Client,
  code: string,
): Promise<TokenExchangeResult> {
  const { tokens } = await oauth2.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error("Google did not return a refresh token");
  }
  const granted = (tokens.scope ?? "").split(/\s+/).filter(Boolean);
  for (const scope of GMAIL_SCOPES) {
    if (!granted.includes(scope)) {
      throw new Error(`Required Gmail scope not granted: ${scope}`);
    }
  }
  oauth2.setCredentials(tokens);
  const gmail = google.gmail({ version: "v1", auth: oauth2 });
  const profile = await gmail.users.getProfile({ userId: "me" });
  return {
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
    scopes: granted,
    emailAddress: profile.data.emailAddress ?? "",
    historyId: profile.data.historyId ?? "",
  };
}
