import { z } from "zod";

const optionalNonempty = z.string().trim().min(1).optional().or(z.literal(""));
const optionalHttpsUrl = z
  .string()
  .url()
  .refine((value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }, "must be an https URL")
  .optional()
  .or(z.literal(""));
const optionalPubSubTopic = z
  .string()
  .trim()
  .regex(/^projects\/[^/\s]+\/topics\/[^/\s]+$/, "must be projects/<project>/topics/<topic>")
  .optional()
  .or(z.literal(""));
const optionalServiceAccountEmail = z.string().trim().email().optional().or(z.literal(""));
const optionalBridgeSecret = z.string().trim().min(32).optional().or(z.literal(""));
// "common", "organizations", "consumers", a tenant GUID or a verified domain.
// It becomes a URL path segment, so only characters valid in those are allowed.
const optionalMicrosoftTenant = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9.-]+$/, "must be common, organizations, consumers, a tenant id or a domain")
  .optional()
  .or(z.literal(""));

export const serverEnvSchema = z.object({
  APP_BASE_URL: optionalNonempty,
  APP_ENV: z.enum(["replay", "sandbox", "live"]).default("replay"),
  VOICE_TRANSPORT: z.enum(["sip_trunk", "media_bridge"]).default("sip_trunk"),
  VOICE_BRIDGE_URL: optionalHttpsUrl,
  VOICE_BRIDGE_SECRET: optionalBridgeSecret,
  SUPABASE_URL: z.string().url(),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  SUPABASE_SECRET_KEY: z.string().min(1),
  CREDENTIAL_ENCRYPTION_KEY: optionalNonempty,
  INNGEST_EVENT_KEY: optionalNonempty,
  INNGEST_SIGNING_KEY: optionalNonempty,
  DEEPSEEK_API_KEY: optionalNonempty,
  DEEPSEEK_BASE_URL: optionalNonempty,
  DEEPSEEK_MODEL: optionalNonempty,
  // Off unless "true". A typo fails loudly instead of silently staying off.
  DEEPSEEK_THINKING_ENABLED: z.enum(["true", "false"]).optional().or(z.literal("")),
  GOOGLE_CLIENT_ID: optionalNonempty,
  ZOHO_CLIENT_ID: optionalNonempty,
  ZOHO_CLIENT_SECRET: optionalNonempty,
  ZOHO_REDIRECT_URI: optionalNonempty,
  GOOGLE_CLIENT_SECRET: optionalNonempty,
  GOOGLE_REDIRECT_URI: optionalNonempty,
  SHOPIFY_CLIENT_ID: optionalNonempty,
  SHOPIFY_CLIENT_SECRET: optionalNonempty,
  // Off unless "true". Requests write_inventory_transfers so approved internal transfers can execute.
  SHOPIFY_TRANSFER_EXECUTION: z.enum(["true", "false"]).optional().or(z.literal("")),
  GMAIL_PROVIDER: z.enum(["google", "composio"]).default("google"),
  GMAIL_PUBSUB_TOPIC: optionalPubSubTopic,
  GMAIL_PUBSUB_AUDIENCE: optionalNonempty,
  GMAIL_PUBSUB_SERVICE_ACCOUNT_EMAIL: optionalServiceAccountEmail,
  COMPOSIO_API_KEY: optionalNonempty,
  COMPOSIO_GMAIL_AUTH_CONFIG_ID: optionalNonempty,
  MICROSOFT_CLIENT_ID: optionalNonempty,
  MICROSOFT_CLIENT_SECRET: optionalNonempty,
  MICROSOFT_REDIRECT_URI: optionalNonempty,
  MICROSOFT_TENANT_ID: optionalMicrosoftTenant,
  ELEVENLABS_API_KEY: optionalNonempty,
  ELEVENLABS_AGENT_ID: optionalNonempty,
  ELEVENLABS_PHONE_NUMBER_ID: optionalNonempty,
  ELEVENLABS_WEBHOOK_SECRET: optionalNonempty,
  EXA_API_KEY: optionalNonempty,
  // Off unless "true". Direct HTTP page fetch for supplier research evidence; Exa stays the default discovery.
  DIRECT_PAGE_FETCH_ENABLED: z.enum(["true", "false"]).optional().or(z.literal("")),
  // Optional comma-separated host allowlist (subdomains included). Blank allows any public host.
  DIRECT_PAGE_FETCH_ALLOWLIST: optionalNonempty,
  SIGNALWIRE_SPACE_URL: optionalNonempty,
  SIGNALWIRE_PROJECT_ID: optionalNonempty,
  SIGNALWIRE_API_TOKEN: optionalNonempty,
  // Off unless "true". When unset, public signup is enabled only in replay (local demo).
  PILOT_SIGNUP_ENABLED: z.enum(["true", "false"]).optional().or(z.literal("")),
  // Comma-separated organization ids that accept invite signups via /signup?invite=<id>.
  PILOT_SIGNUP_INVITE_ORG_IDS: optionalNonempty,
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;
export type CapabilityName =
  | "deepseek"
  | "gmail"
  | "outlook"
  | "voice"
  | "exa"
  | "inngest";

export type CapabilityStatus = Record<CapabilityName, { ready: boolean; missing: string[] }>;

export function parseServerEnv(input: NodeJS.ProcessEnv | Record<string, string | undefined>) {
  return serverEnvSchema.parse(input);
}

export function capabilities(
  env: ServerEnv = parseServerEnv(process.env),
): CapabilityStatus {
  const required: Record<CapabilityName, string[]> = {
    deepseek: ["DEEPSEEK_API_KEY", "DEEPSEEK_MODEL"],
    gmail:
      env.GMAIL_PROVIDER === "composio"
        ? [
            "COMPOSIO_API_KEY",
            "COMPOSIO_GMAIL_AUTH_CONFIG_ID",
            "CREDENTIAL_ENCRYPTION_KEY",
          ]
        : ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"],
    outlook: [
      "MICROSOFT_CLIENT_ID",
      "MICROSOFT_CLIENT_SECRET",
      "MICROSOFT_REDIRECT_URI",
      "CREDENTIAL_ENCRYPTION_KEY",
    ],
    voice: [
      "ELEVENLABS_API_KEY",
      "ELEVENLABS_AGENT_ID",
      "ELEVENLABS_WEBHOOK_SECRET",
      ...(env.VOICE_TRANSPORT === "media_bridge"
        ? ["VOICE_BRIDGE_URL", "VOICE_BRIDGE_SECRET"]
        : ["ELEVENLABS_PHONE_NUMBER_ID"]),
    ],
    exa: ["EXA_API_KEY"],
    inngest: ["INNGEST_EVENT_KEY", "INNGEST_SIGNING_KEY"],
  };

  return Object.fromEntries(
    Object.entries(required).map(([name, keys]) => {
      const missing = keys.filter((key) => !env[key as keyof ServerEnv]);
      return [name, { ready: missing.length === 0, missing }];
    }),
  ) as CapabilityStatus;
}
