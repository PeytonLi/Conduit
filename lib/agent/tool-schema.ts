import { z } from "zod";

/** JSON-schema view of a tool input for the model tool list. */
export function toolInputToJsonSchema(input: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(input) as Record<string, unknown>;
}
