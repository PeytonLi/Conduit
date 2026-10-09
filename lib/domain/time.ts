import { DomainValidationError } from "./errors";

const INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const formatterCache = new Map<string, Intl.DateTimeFormat>();

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

export function parseInstant(value: string): number | null {
  const match = INSTANT_PATTERN.exec(value);
  if (!match) return null;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText = "0", , offset] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(0, 0, 0, 0);
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }
  if (offset !== "Z") {
    const [, , offsetHour, offsetMinute] = /^([+-])(\d{2}):(\d{2})$/.exec(offset)!;
    if (Number(offsetHour) > 23 || Number(offsetMinute) > 59) return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateParts(value: string, timeZone: string): [number, number, number] {
  const dateMatch = DATE_PATTERN.exec(value);
  if (dateMatch) {
    const [, year, month, day] = dateMatch;
    const y = Number(year);
    const m = Number(month);
    const d = Number(day);
    const check = new Date(0);
    check.setUTCFullYear(y, m - 1, d);
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
      throw new DomainValidationError("invalid_date", "date");
    }
    return [y, m, d];
  }
  const instant = parseInstant(value);
  if (instant === null) throw new DomainValidationError("invalid_time", "instant");
  const parts = formatterFor(timeZone).formatToParts(instant);
  return [
    Number(parts.find((part) => part.type === "year")?.value),
    Number(parts.find((part) => part.type === "month")?.value),
    Number(parts.find((part) => part.type === "day")?.value),
  ];
}

function dateString([year, month, day]: [number, number, number]): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function addCalendarDays(parts: [number, number, number], days: number): [number, number, number] {
  const date = new Date(0);
  date.setUTCFullYear(parts[0], parts[1] - 1, parts[2] + days);
  date.setUTCHours(0, 0, 0, 0);
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
}

function localDateAt(epochMs: number, timeZone: string): string {
  const parts = formatterFor(timeZone).formatToParts(epochMs);
  return dateString([
    Number(parts.find((part) => part.type === "year")?.value),
    Number(parts.find((part) => part.type === "month")?.value),
    Number(parts.find((part) => part.type === "day")?.value),
  ]);
}

function firstInstantOfDate(parts: [number, number, number], timeZone: string): number {
  const targetDate = dateString(parts);
  const approximate = Date.UTC(parts[0], parts[1] - 1, parts[2]);
  let low = approximate - 48 * 60 * 60 * 1000;
  let high = approximate + 48 * 60 * 60 * 1000;
  if (localDateAt(low, timeZone) >= targetDate || localDateAt(high, timeZone) < targetDate) {
    throw new DomainValidationError("invalid_date", "date");
  }
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (localDateAt(middle, timeZone) >= targetDate) high = middle;
    else low = middle;
  }
  return high;
}

export function startOfLocalDate(instantOrDate: string, timeZone: string): number {
  if (!isValidTimeZone(timeZone)) throw new DomainValidationError("invalid_timezone", "timeZone");
  const date = dateParts(instantOrDate, timeZone);
  return firstInstantOfDate(date, timeZone);
}

export function endOfLocalDate(instantOrDate: string, timeZone: string): number {
  if (!isValidTimeZone(timeZone)) throw new DomainValidationError("invalid_timezone", "timeZone");
  const date = dateParts(instantOrDate, timeZone);
  return firstInstantOfDate(addCalendarDays(date, 1), timeZone) - 1;
}

export function toIso(epochMs: number): string {
  const iso = new Date(epochMs).toISOString();
  return iso.endsWith(".000Z") ? `${iso.slice(0, -5)}Z` : iso;
}
