"use server";

import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/db/server";

export async function signIn(formData: FormData) {
  const email = formData.get("email");
  const password = formData.get("password");
  if (typeof email !== "string" || typeof password !== "string") {
    redirect("/login?error=invalid");
  }

  const supabase = await createServerClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    redirect("/login?error=credentials");
  }
  redirect("/cases");
}
