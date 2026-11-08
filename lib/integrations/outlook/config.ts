export const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
export const GRAPH_HOST = "graph.microsoft.com";
export const MICROSOFT_LOGIN_BASE_URL = "https://login.microsoftonline.com";

/**
 * Scopes requested at consent.
 *
 * Mail.ReadWrite is needed only because Microsoft Graph requires it to create a
 * draft, and Conduit sends through a draft so the Message-ID is set up front and
 * a send can be reconciled afterwards. Conduit never edits or deletes messages
 * that already exist in the mailbox.
 */
export const OUTLOOK_SCOPES = [
  "offline_access",
  "User.Read",
  "Mail.ReadWrite",
  "Mail.Send",
] as const;

/** Granted scopes the connection cannot work without. */
export const OUTLOOK_REQUIRED_SCOPES = ["Mail.ReadWrite", "Mail.Send"] as const;

export interface OutlookEnv {
  APP_ENV?: string;
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_CLIENT_SECRET?: string;
  MICROSOFT_REDIRECT_URI?: string;
  MICROSOFT_TENANT_ID?: string;
  CREDENTIAL_ENCRYPTION_KEY?: string;
}

export interface OutlookConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tenant: string;
  signingKey: string;
}

/** App registration plus the encryption key, or null when not configured. */
export function outlookConfig(env: OutlookEnv): OutlookConfig | null {
  if (
    !env.MICROSOFT_CLIENT_ID ||
    !env.MICROSOFT_CLIENT_SECRET ||
    !env.MICROSOFT_REDIRECT_URI ||
    !env.CREDENTIAL_ENCRYPTION_KEY
  ) {
    return null;
  }
  return {
    clientId: env.MICROSOFT_CLIENT_ID,
    clientSecret: env.MICROSOFT_CLIENT_SECRET,
    redirectUri: env.MICROSOFT_REDIRECT_URI,
    tenant: env.MICROSOFT_TENANT_ID || "common",
    signingKey: env.CREDENTIAL_ENCRYPTION_KEY,
  };
}

/** The Outlook poll never runs in replay and requires provider credentials. */
export function outlookPollEnabled(env: OutlookEnv): boolean {
  if (env.APP_ENV === "replay") return false;
  return outlookConfig(env) !== null;
}
