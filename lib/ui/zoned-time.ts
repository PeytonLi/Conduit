function offsetMs(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instantMs));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const wallAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return wallAsUtc - Math.floor(instantMs / 1000) * 1000;
}

/**
 * Turns a `datetime-local` value, read as wall-clock time in `timeZone`, into an ISO instant.
 * Returns null for malformed input or an unknown zone. A wall time skipped by a DST jump resolves
 * to the instant just after the jump.
 */
export function localDateTimeToIso(local: string, timeZone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  try {
    const first = wall - offsetMs(wall, timeZone);
    const second = wall - offsetMs(first, timeZone);
    // When the two guesses disagree the wall time falls in a DST gap; `first` lands after the jump.
    const resolved = second + offsetMs(second, timeZone) === wall ? second : first;
    const date = new Date(resolved);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  } catch {
    return null;
  }
}
