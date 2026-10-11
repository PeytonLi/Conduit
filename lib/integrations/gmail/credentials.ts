export type GmailCredential =
  | { provider: "google"; refreshToken: string }
  | { provider: "composio"; connectedAccountId: string };

export function serializeGmailCredential(credential: GmailCredential): string {
  return JSON.stringify(credential);
}

export function parseGmailCredential(plaintext: string): GmailCredential {
  try {
    const value = JSON.parse(plaintext) as Partial<GmailCredential>;
    if (
      value.provider === "composio" &&
      typeof value.connectedAccountId === "string" &&
      value.connectedAccountId.length > 0
    ) {
      return { provider: "composio", connectedAccountId: value.connectedAccountId };
    }
    if (
      value.provider === "google" &&
      typeof value.refreshToken === "string" &&
      value.refreshToken.length > 0
    ) {
      return { provider: "google", refreshToken: value.refreshToken };
    }
  } catch {
    return { provider: "google", refreshToken: plaintext };
  }
  return { provider: "google", refreshToken: plaintext };
}
