import { z } from "zod";

const optionalNonempty = z.string().trim().min(1).optional().or(z.literal(""));

export const serverEnvSchema = z.object({
  APP_BASE_URL: optionalNonempty,
  APP_ENV: z.enum(["replay", "sandbox", "live"]).default("replay"),
  SUPABASE_URL: z.string().url(),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  SUPABASE_SECRET_KEY: z.string().min(1),
  CREDENTIAL_ENCRYPTION_KEY: optionalNonempty,
  INNGEST_EVENT_KEY: optionalNonempty,
  INNGEST_SIGNING_KEY: optionalNonempty,
  DEEPSEEK_API_KEY: optionalNonempty,
  DEEPSEEK_BASE_URL: optionalNonempty,
  DEEPSEEK_MODEL: optionalNonempty,
  GOOGLE_CLIENT_ID: optionalNonempty,
  GOOGLE_CLIENT_SECRET: optionalNonempty,
  GOOGLE_REDIRECT_URI: optionalNonempty,
  ELEVENLABS_API_KEY: optionalNonempty,
  ELEVENLABS_AGENT_ID: optionalNonempty,
  ELEVENLABS_PHONE_NUMBER_ID: optionalNonempty,
  ELEVENLABS_WEBHOOK_SECRET: optionalNonempty,
  EXA_API_KEY: optionalNonempty,
  NEATLOGS_API_KEY: optionalNonempty,
  NEATLOGS_ENDPOINT: optionalNonempty,
  SIGNALWIRE_SPACE_URL: optionalNonempty,
  SIGNALWIRE_PROJECT_ID: optionalNonempty,
  SIGNALWIRE_API_TOKEN: optionalNonempty,
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;
export type CapabilityName =
  | "deepseek"
  | "gmail"
  | "voice"
  | "exa"
  | "neatlogs"
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
    gmail: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"],
    voice: [
      "ELEVENLABS_API_KEY",
      "ELEVENLABS_AGENT_ID",
      "ELEVENLABS_PHONE_NUMBER_ID",
      "ELEVENLABS_WEBHOOK_SECRET",
    ],
    exa: ["EXA_API_KEY"],
    neatlogs: ["NEATLOGS_API_KEY", "NEATLOGS_ENDPOINT"],
    inngest: ["INNGEST_EVENT_KEY", "INNGEST_SIGNING_KEY"],
  };

  return Object.fromEntries(
    Object.entries(required).map(([name, keys]) => {
      const missing = keys.filter((key) => !env[key as keyof ServerEnv]);
      return [name, { ready: missing.length === 0, missing }];
    }),
  ) as CapabilityStatus;
}
