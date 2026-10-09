"use server";

import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/db/server";

export async function signOut() {
  const client = await createServerClient();
  await client.auth.signOut();
  redirect("/login");
}
