import "server-only";
import { createClient } from "@supabase/supabase-js";
import { parseServerEnv } from "@/lib/env";

export function createServiceClient() {
  const env = parseServerEnv(process.env);
  return createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
