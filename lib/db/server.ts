import { createServerClient as createSupabaseServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { parseServerEnv } from "@/lib/env";

export async function createServerClient() {
  const env = parseServerEnv(process.env);
  const cookieStore = await cookies();

  return createSupabaseServerClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // Server components cannot write cookies; middleware refreshes sessions.
        }
      },
    },
  });
}
