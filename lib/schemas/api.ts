import { z } from "zod";

export const fieldErrorSchema = z.object({
  field: z.string(),
  message: z.string(),
});

export const apiErrorSchema = z.object({
  code: z.string(),
  safe_message: z.string(),
  retryable: z.boolean(),
  field_errors: z.array(fieldErrorSchema).optional(),
});

export const apiEnvelopeSchema = <T extends z.ZodType>(dataSchema: T) =>
  z.union([
    z.object({
      api_schema_version: z.literal(1),
      request_id: z.string().uuid(),
      data: dataSchema,
    }),
    z.object({
      api_schema_version: z.literal(1),
      request_id: z.string().uuid(),
      error: apiErrorSchema,
    }),
  ]);

export const assessmentResponseSchema = z.object({
  api_schema_version: z.literal(1),
  request_id: z.string().uuid(),
  data: z.object({
    case_id: z.string().uuid(),
    assessment_version: z.number().int().positive(),
    quality: z.enum(["sufficient", "insufficient"]),
    unit: z.string(),
    first_shortage_at: z.string().datetime().nullable(),
    bridge_quantity: z.number().int().nonnegative().nullable(),
    requirements: z.array(
      z.object({
        by: z.string().datetime(),
        cumulative_quantity: z.number().int().nonnegative(),
      }),
    ),
    source_as_of: z.string().datetime(),
    input_fingerprint: z.string(),
    evidence_ids: z.array(z.string().uuid()),
    mode: z.enum(["replay", "sandbox", "live"]),
  }),
});

export type ApiError = z.infer<typeof apiErrorSchema>;
export type AssessmentResponse = z.infer<typeof assessmentResponseSchema>;
