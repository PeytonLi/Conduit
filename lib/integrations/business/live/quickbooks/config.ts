import { z } from "zod";

export const QBO_SCOPE = "com.intuit.quickbooks.accounting";
/** Intuit ignores anything below 75 since 2025-08-01; pin it so responses stay stable. */
export const QBO_MINOR_VERSION = "75";
export const QBO_AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
export const QBO_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
export const QBO_CALLBACK_PATH = "/api/auth/quickbooks/callback";

export const qboEnvironmentSchema = z.enum(["sandbox", "production"]);
export type QboEnvironment = z.infer<typeof qboEnvironmentSchema>;

export function qboApiBaseUrl(environment: QboEnvironment): string {
  return environment === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";
}

const optional = z.string().trim().min(1).optional().or(z.literal("").transform(() => undefined));

const qboEnvSchema = z.object({
  QBO_CLIENT_ID: optional,
  QBO_CLIENT_SECRET: optional,
  QBO_ENVIRONMENT: qboEnvironmentSchema.default("sandbox"),
  QBO_REDIRECT_URI: optional,
  APP_BASE_URL: optional,
  CREDENTIAL_ENCRYPTION_KEY: optional,
});

export interface QboConfig {
  clientId: string;
  clientSecret: string;
  environment: QboEnvironment;
  redirectUri: string;
  encryptionKey: string;
}

export type QboConfigResult =
  | { configured: true; config: QboConfig }
  | { configured: false; missing: string[] };

/** Reads QuickBooks settings; missing credentials mean "not configured", never a crash. */
export function readQboConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  requestOrigin?: string,
): QboConfigResult {
  const parsed = qboEnvSchema.parse(env);
  const origin = parsed.APP_BASE_URL ? new URL(parsed.APP_BASE_URL).origin : requestOrigin;
  const redirectUri = parsed.QBO_REDIRECT_URI ?? (origin ? new URL(QBO_CALLBACK_PATH, origin).toString() : undefined);
  const missing = [
    !parsed.QBO_CLIENT_ID && "QBO_CLIENT_ID",
    !parsed.QBO_CLIENT_SECRET && "QBO_CLIENT_SECRET",
    !parsed.CREDENTIAL_ENCRYPTION_KEY && "CREDENTIAL_ENCRYPTION_KEY",
    !redirectUri && "APP_BASE_URL",
  ].filter((value): value is string => Boolean(value));
  if (missing.length) return { configured: false, missing };
  return {
    configured: true,
    config: {
      clientId: parsed.QBO_CLIENT_ID!,
      clientSecret: parsed.QBO_CLIENT_SECRET!,
      environment: parsed.QBO_ENVIRONMENT,
      redirectUri: redirectUri!,
      encryptionKey: parsed.CREDENTIAL_ENCRYPTION_KEY!,
    },
  };
}
