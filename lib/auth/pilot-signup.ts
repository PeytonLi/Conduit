import { parseServerEnv, type ServerEnv } from "@/lib/env";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isPilotSignupEnabled(env: ServerEnv = parseServerEnv(process.env)): boolean {
  if (env.PILOT_SIGNUP_ENABLED === "true") return true;
  if (env.PILOT_SIGNUP_ENABLED === "false") return false;
  return env.APP_ENV === "replay";
}

export function parseInviteOrgId(
  value: string | undefined,
  env: ServerEnv = parseServerEnv(process.env),
): string | null {
  if (!value?.trim() || !uuidPattern.test(value.trim())) return null;
  const orgId = value.trim();
  const allowed = env.PILOT_SIGNUP_INVITE_ORG_IDS?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean) ?? [];
  if (!allowed.includes(orgId)) return null;
  return orgId;
}
