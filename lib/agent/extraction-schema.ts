import { z } from "zod";

export const PROMPT_VERSION = "inbox-extraction-v1";

const localDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable();

const localTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
  .nullable();

const promiseSchema = z
  .object({
    quote: z.string(),
    local_date: localDateSchema,
    local_time: localTimeSchema,
  })
  .strict();

const newPromiseSchema = z
  .object({
    quote: z.string(),
    local_date: localDateSchema,
    local_time: localTimeSchema,
    promise_state: z.enum(["confirmed", "estimated"]),
  })
  .strict();

export const extractionLineSchema = z
  .object({
    order_ref: z.string().nullable(),
    line_ref: z.string().nullable(),
    item_ref: z.string().nullable(),
    affected_quantity: z.number().int().min(0).nullable(),
    quantity_scope: z.enum(["all_remaining", "partial", "unstated"]),
    unit: z.string().nullable(),
    old_promise: promiseSchema.nullable(),
    new_promise: newPromiseSchema.nullable(),
    quantity_quote: z.string().nullable(),
    order_quote: z.string().nullable(),
  })
  .strict();

export const extractionV1Schema = z
  .object({
    schema_version: z.literal(1),
    is_delay_notice: z.boolean(),
    lines: z.array(extractionLineSchema).max(20),
    notes_for_reviewer: z.string().max(500),
  })
  .strict();

export type ExtractionLine = z.infer<typeof extractionLineSchema>;
export type ExtractionV1 = z.infer<typeof extractionV1Schema>;
