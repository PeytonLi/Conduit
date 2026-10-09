import "server-only";
import { createServiceClient } from "@/lib/db/service";
import type { VoiceStore } from "@/lib/db/voice-store";
import { createSupabaseVoiceStore } from "@/lib/db/voice-store-supabase";
import { capabilities, parseServerEnv } from "@/lib/env";
import { createElevenLabsVoiceClient, type VoiceProviderClient } from "./client";

let store: VoiceStore | undefined;

export function getVoiceStore(): VoiceStore {
  store ??= createSupabaseVoiceStore(createServiceClient());
  return store;
}

export function getVoiceEnv() {
  return parseServerEnv(process.env);
}

/** Returns null unless every voice credential is present and the app is not in replay. */
export function getVoiceProvider(): VoiceProviderClient | null {
  const env = getVoiceEnv();
  if (env.APP_ENV === "replay" || !capabilities(env).voice.ready) return null;
  return createElevenLabsVoiceClient({
    apiKey: env.ELEVENLABS_API_KEY!,
    agentId: env.ELEVENLABS_AGENT_ID!,
    phoneNumberId: env.ELEVENLABS_PHONE_NUMBER_ID!,
  });
}
