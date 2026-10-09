import { describe, expect, it } from "vitest";
import {
  canCommit,
  isFresh,
  outreachDenials,
  withinContactHours,
  withinNegotiationCeiling,
  type ContactFacts,
} from "./checks";
import { defaultPolicySettings, policySettingsSchema } from "./schema";

const enabled = policySettingsSchema.parse({ outreach: { email_enabled: true, call_enabled: true } });
const contact: ContactFacts = {
  supplierId: "s1",
  channel: "email",
  permittedChannels: ["email"],
  outreachApprovedAt: "2026-10-01T00:00:00Z",
  timezone: "America/Chicago",
  supplierStatus: "approved",
};
const noCounts = { otherSuppliersContacted: 0, sameSupplierSameChannel: 0, totalSameChannel: 0 };
// Fixture clock: Monday 2026-10-12 15:00Z = 10:00 in Chicago.
const fixtureNow = new Date("2026-10-12T15:00:00Z");

describe("policy checks", () => {
  it("defaults are safe: outreach disabled, owner-only authority, zero autonomous commitment", () => {
    expect(defaultPolicySettings.outreach.email_enabled).toBe(false);
    expect(defaultPolicySettings.outreach.call_enabled).toBe(false);
    expect(defaultPolicySettings.commitment_authority).toBe("owner");
    expect(defaultPolicySettings.budgets.autonomous_commitment_minor).toBe("0");
    expect(defaultPolicySettings.approval.validity_seconds).toBe(1800);
    expect(() => policySettingsSchema.parse({ approval: { validity_seconds: 3600 } })).toThrow();
  });

  it("evaluates supplier hours in the contact's own timezone", () => {
    expect(withinContactHours(enabled, "America/Chicago", fixtureNow)).toBe(true);
    // 15:00Z is 00:00 the next day in Tokyo.
    expect(withinContactHours(enabled, "Asia/Tokyo", fixtureNow)).toBe(false);
    expect(withinContactHours(enabled, "America/Chicago", new Date("2026-10-11T15:00:00Z"))).toBe(false); // Sunday
    expect(withinContactHours(enabled, null, fixtureNow)).toBe(false);
    expect(withinContactHours(enabled, "Not/AZone", fixtureNow)).toBe(false);
  });

  it("permits an approved contact within hours and limits", () => {
    expect(
      outreachDenials({ settings: enabled, caseRunControl: "active", contact, channel: "email", counts: noCounts, now: fixtureNow }),
    ).toEqual([]);
  });

  it("denies unapproved contacts, disabled channels, pause and exhausted per-episode limits", () => {
    const denials = outreachDenials({
      settings: { ...defaultPolicySettings, dispatch_paused: true },
      caseRunControl: "paused",
      contact: { ...contact, outreachApprovedAt: null },
      channel: "email",
      counts: { otherSuppliersContacted: 3, sameSupplierSameChannel: 2, totalSameChannel: 2 },
      now: fixtureNow,
    });
    expect(denials).toEqual(
      expect.arrayContaining([
        "dispatch_paused",
        "case_not_active",
        "contact_not_approved",
        "channel_disabled",
        "supplier_limit",
        "email_limit_supplier",
      ]),
    );
    const calls = outreachDenials({
      settings: enabled,
      caseRunControl: "active",
      contact: { ...contact, channel: "phone", permittedChannels: ["phone"] },
      channel: "phone",
      counts: { otherSuppliersContacted: 0, sameSupplierSameChannel: 1, totalSameChannel: 3 },
      now: fixtureNow,
    });
    expect(calls).toEqual(["call_limit_supplier", "call_limit_case"]);
  });

  it("only owners can commit; ceilings and freshness use integer/clock math", () => {
    expect(canCommit("owner", defaultPolicySettings)).toBe(true);
    expect(canCommit("operator", defaultPolicySettings)).toBe(false);
    expect(withinNegotiationCeiling(defaultPolicySettings, 1n)).toBe(false);
    const ceiling = policySettingsSchema.parse({ negotiation: { ceiling_minor: "9007199254740993" } });
    expect(withinNegotiationCeiling(ceiling, 9007199254740993n)).toBe(true);
    expect(withinNegotiationCeiling(ceiling, 9007199254740994n)).toBe(false);
    expect(isFresh(new Date("2026-10-12T14:45:00Z"), fixtureNow, 900)).toBe(true);
    expect(isFresh(new Date("2026-10-12T14:44:59Z"), fixtureNow, 900)).toBe(false);
  });
});
