import { z } from "zod";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const minor = z.string().regex(/^\d+$/, "Money is integer minor units");

/** Versioned organization policy. Stored immutably in policies.settings; the DB enforces the same keys. */
export const policySettingsSchema = z
  .object({
    dispatch_paused: z.boolean().default(false),
    commitment_authority: z.literal("owner").default("owner"),
    outreach: z
      .object({
        email_enabled: z.boolean().default(false),
        call_enabled: z.boolean().default(false),
        contact_hours: z
          .object({
            weekdays: z.array(z.number().int().min(1).max(7)).min(1).default([1, 2, 3, 4, 5]),
            start: hhmm.default("09:00"),
            end: hhmm.default("17:00"),
          })
          .strict()
          .default({ weekdays: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" }),
        max_suppliers_per_episode: z.number().int().min(0).max(20).default(3),
        max_calls_per_supplier_per_episode: z.number().int().min(0).max(5).default(1),
        max_calls_per_episode: z.number().int().min(0).max(10).default(3),
        max_emails_per_supplier_per_episode: z.number().int().min(0).max(10).default(2),
      })
      .strict()
      .prefault({}),
    negotiation: z
      .object({ ceiling_minor: minor.nullable().default(null) })
      .strict()
      .prefault({}),
    approval: z
      .object({ validity_seconds: z.number().int().min(60).max(1800).default(1800) })
      .strict()
      .prefault({}),
    freshness: z
      .object({
        live_business_data_seconds: z.number().int().min(60).max(86_400).default(900),
        availability_recheck_seconds: z.number().int().min(60).max(86_400).default(3600),
      })
      .strict()
      .prefault({}),
    budgets: z
      .object({
        max_active_case_steps: z.number().int().min(1).max(50).default(5),
        max_inflight_calls_per_org: z.number().int().min(0).max(10).default(1),
        autonomous_commitment_minor: z.literal("0").default("0"),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export type PolicySettings = z.infer<typeof policySettingsSchema>;

export const defaultPolicySettings: PolicySettings = policySettingsSchema.parse({});

export const createPolicyRequestSchema = z
  .object({
    expected_version: z.number().int().min(0),
    reason: z.string().trim().min(1).max(500),
    settings: policySettingsSchema,
  })
  .strict();
