import type { MembershipRole } from "@/lib/schemas/enums";
import type { PolicySettings } from "./schema";

/**
 * Deterministic policy checks shared by every feature. The ledger re-runs the same checks in
 * Postgres inside the prepare transaction; these functions let callers explain a denial early.
 */
export type PolicyDenial =
  | "dispatch_paused"
  | "case_not_active"
  | "contact_not_approved"
  | "channel_mismatch"
  | "channel_not_permitted"
  | "channel_disabled"
  | "supplier_blocked"
  | "outside_contact_hours"
  | "supplier_limit"
  | "call_limit_supplier"
  | "call_limit_case"
  | "email_limit_supplier";

export interface ContactFacts {
  supplierId: string;
  channel: "email" | "phone";
  permittedChannels: string[];
  outreachApprovedAt: string | null;
  timezone: string | null;
  supplierStatus: "candidate" | "approved" | "blocked";
}

export interface EpisodeCounts {
  /** Distinct suppliers already contacted this episode, excluding this contact's supplier. */
  otherSuppliersContacted: number;
  sameSupplierSameChannel: number;
  totalSameChannel: number;
}

export function localTimeParts(now: Date, timeZone: string): { isoWeekday: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return {
    isoWeekday: weekdays.indexOf(get("weekday")) + 1,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

export function isValidTimeZone(timeZone: string | null): timeZone is string {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Supplier hours are evaluated in the contact's own timezone; unknown timezone means not allowed. */
export function withinContactHours(settings: PolicySettings, timeZone: string | null, now: Date): boolean {
  if (!isValidTimeZone(timeZone)) return false;
  const { isoWeekday, minutes } = localTimeParts(now, timeZone);
  const hours = settings.outreach.contact_hours;
  return hours.weekdays.includes(isoWeekday) && minutes >= toMinutes(hours.start) && minutes < toMinutes(hours.end);
}

export function outreachDenials(input: {
  settings: PolicySettings;
  caseRunControl: "active" | "paused" | "blocked";
  contact: ContactFacts;
  channel: "email" | "phone";
  counts: EpisodeCounts;
  now: Date;
}): PolicyDenial[] {
  const { settings, contact, channel, counts } = input;
  const denials: PolicyDenial[] = [];
  const outreach = settings.outreach;
  if (settings.dispatch_paused) denials.push("dispatch_paused");
  if (input.caseRunControl !== "active") denials.push("case_not_active");
  if (!contact.outreachApprovedAt) denials.push("contact_not_approved");
  if (contact.channel !== channel) denials.push("channel_mismatch");
  if (!contact.permittedChannels.includes(channel)) denials.push("channel_not_permitted");
  if (contact.supplierStatus === "blocked") denials.push("supplier_blocked");
  if (!(channel === "email" ? outreach.email_enabled : outreach.call_enabled)) denials.push("channel_disabled");
  if (!withinContactHours(settings, contact.timezone, input.now)) denials.push("outside_contact_hours");
  if (counts.otherSuppliersContacted + 1 > outreach.max_suppliers_per_episode) denials.push("supplier_limit");
  if (channel === "phone") {
    if (counts.sameSupplierSameChannel + 1 > outreach.max_calls_per_supplier_per_episode) denials.push("call_limit_supplier");
    if (counts.totalSameChannel + 1 > outreach.max_calls_per_episode) denials.push("call_limit_case");
  } else if (counts.sameSupplierSameChannel + 1 > outreach.max_emails_per_supplier_per_episode) {
    denials.push("email_limit_supplier");
  }
  return denials;
}

/** Only owners hold commitment authority; autonomous commitments are always zero. */
export function canCommit(role: MembershipRole, settings: PolicySettings): boolean {
  return settings.commitment_authority === "owner" && role === "owner";
}

export function canChangePolicy(role: MembershipRole): boolean {
  return role === "owner";
}

export function isFresh(sourceAsOf: Date, now: Date, maxAgeSeconds: number): boolean {
  return now.getTime() - sourceAsOf.getTime() <= maxAgeSeconds * 1000;
}

export function dispatchAllowed(settings: PolicySettings): boolean {
  return !settings.dispatch_paused;
}

/** Negotiation ceiling check in integer minor units (BigInt, never floating point). */
export function withinNegotiationCeiling(settings: PolicySettings, amountMinor: bigint): boolean {
  const ceiling = settings.negotiation.ceiling_minor;
  return ceiling !== null && amountMinor <= BigInt(ceiling);
}
