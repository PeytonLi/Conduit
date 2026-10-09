import { randomUUID } from "node:crypto";
import { z } from "zod";
import { apiErrorSchema } from "@/lib/schemas/api";

export function ok<T>(data: T, status = 200): Response {
  return Response.json(
    { api_schema_version: 1, request_id: randomUUID(), data },
    { status },
  );
}

export function fail(
  code: string,
  safeMessage: string,
  status: number,
  retryable: boolean,
  fieldErrors?: { field: string; message: string }[],
): Response {
  const error = apiErrorSchema.parse({
    code,
    safe_message: safeMessage,
    retryable,
    ...(fieldErrors ? { field_errors: fieldErrors } : {}),
  });
  return Response.json(
    { api_schema_version: 1, request_id: randomUUID(), error },
    { status },
  );
}

export async function parseBody<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<{ success: true; data: z.infer<T> } | { success: false; response: Response }> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return {
      success: false,
      response: fail("invalid_json", "Request body must be valid JSON", 422, false),
    };
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return {
      success: false,
      response: fail(
        "validation_failed",
        "Request body is invalid",
        422,
        false,
        parsed.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      ),
    };
  }
  return { success: true, data: parsed.data };
}

export function idempotencyKey(request: Request): string | null {
  const key = request.headers.get("Idempotency-Key")?.trim();
  return key || null;
}
