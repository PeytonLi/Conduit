import { HARBOR_PACK_FIXTURE_CLOCK } from "@/lib/demo/fixtures";

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export function dateFromClock(clock: Clock = systemClock): Date {
  return clock.now();
}

export function caseEvaluationTime(
  dataLabel: "Replay" | "Imported" | "Live" | null,
  sourceVersions: Record<string, unknown> | null,
  now: Date,
): Date {
  if (dataLabel !== "Replay") return now;
  const fixtureClock = sourceVersions?.fixture_clock;
  if (typeof fixtureClock === "string") {
    const parsed = new Date(fixtureClock);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date(HARBOR_PACK_FIXTURE_CLOCK);
}

export function isExpiredAt(expiresAt: string | null, now: Date): boolean {
  if (!expiresAt) return false;
  const expiry = new Date(expiresAt).getTime();
  return Number.isFinite(expiry) && expiry <= now.getTime();
}
