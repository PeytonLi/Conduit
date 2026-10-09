import { fail, idempotencyKey, ok } from "@/lib/api/http";
import { getImportStore } from "@/lib/db/imports";
import { createImport } from "@/lib/db/imports/service";
import {
  importMetadataSchema,
  membershipOrResponse,
  originFailure,
} from "./_shared";

const maxFileBytes = 5 * 1024 * 1024;
const maxTotalBytes = 20 * 1024 * 1024;

function stageResponse(result: Awaited<ReturnType<typeof createImport>>, replayed = false): Response {
  switch (result.outcome) {
    case "staged":
      return ok({
        import_id: result.import_id,
        status: "staged",
        row_version: result.row_version,
        dataset_id: result.dataset_id,
        validation_summary: result.validation_summary,
        preview: { counts: result.validation_summary.counts },
      }, replayed ? 200 : 201);
    case "invalid":
      return ok({
        import_id: result.import_id,
        status: "invalid",
        validation_summary: result.validation_summary,
      }, replayed ? 200 : 201);
    case "replayed":
      return result.status === "invalid"
        ? ok({
          import_id: result.import_id,
          status: "invalid",
          validation_summary: result.validation_summary,
        }, 200)
        : ok({
          import_id: result.import_id,
          status: "staged",
          row_version: 1,
          dataset_id: result.dataset_id,
          validation_summary: result.validation_summary,
          preview: { counts: result.validation_summary.counts },
        }, 200);
    case "noop_same_content":
      return ok({
        import_id: result.import_id,
        status: "active",
        noop: true,
        dataset_id: result.dataset_id,
      }, 200);
    case "idempotency_conflict":
      return fail("idempotency_conflict", "Idempotency key was used for different content", 409, false);
  }
}

export async function POST(request: Request): Promise<Response> {
  const { membership, response: membershipResponse } = await membershipOrResponse();
  if (membershipResponse) return membershipResponse;

  const originResponse = originFailure(request);
  if (originResponse) return originResponse;

  const key = idempotencyKey(request);
  if (!key) return fail("idempotency_key_required", "Idempotency-Key header is required", 422, false);

  const mediaType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "multipart/form-data") {
    return fail("unsupported_media_type", "Request must use multipart/form-data", 415, false);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail("validation_failed", "Multipart form data is invalid", 422, false);
  }

  const metadataParts = form.getAll("metadata");
  const metadataValue = metadataParts[0];
  if (metadataParts.length !== 1 || typeof metadataValue !== "string") {
    return fail("validation_failed", "Import metadata is required", 422, false, [
      { field: "metadata", message: "Required" },
    ]);
  }

  let rawMetadata: unknown;
  try {
    rawMetadata = JSON.parse(metadataValue);
  } catch {
    return fail("validation_failed", "Import metadata must be valid JSON", 422, false, [
      { field: "metadata", message: "Must be valid JSON" },
    ]);
  }
  const metadata = importMetadataSchema.safeParse(rawMetadata);
  if (!metadata.success) {
    return fail("validation_failed", "Import metadata is invalid", 422, false,
      metadata.error.issues.map((issue) => ({
        field: `metadata.${issue.path.join(".")}`,
        message: issue.message,
      })));
  }

  const files: Record<string, string> = Object.create(null);
  let totalBytes = 0;
  for (const [field, value] of form.entries()) {
    if (field === "metadata" || typeof value === "string") continue;
    if (value.size > maxFileBytes) {
      return fail("payload_too_large", "A CSV file exceeds the 5 MB limit", 413, false);
    }
    totalBytes += value.size;
    if (totalBytes > maxTotalBytes) {
      return fail("payload_too_large", "Combined CSV files exceed the 20 MB limit", 413, false);
    }
    if (Object.hasOwn(files, field)) {
      return fail("validation_failed", "A CSV file part was supplied more than once", 422, false, [
        { field, message: "Duplicate file part" },
      ]);
    }
    files[field] = await value.text();
  }

  try {
    const result = await createImport({
      store: getImportStore(),
      orgId: membership!.orgId,
      userId: membership!.userId,
      idempotencyKey: key,
      files,
      metadata: metadata.data,
      now: new Date().toISOString(),
    });
    return stageResponse(result, result.outcome === "replayed");
  } catch {
    return fail("internal_error", "Import could not be processed", 500, true);
  }
}
