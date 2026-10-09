import { z } from "zod";
import { fail, idempotencyKey, ok, parseBody } from "@/lib/api/http";
import { getImportStore } from "@/lib/db/imports";
import { activate } from "@/lib/db/imports/service";
import { membershipOrResponse, originFailure } from "../../_shared";

const importIdSchema = z.string().uuid();
const activateSchema = z.object({
  expected_version: z.number().int().positive(),
  contact_permissions_confirmed: z.boolean().default(false),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ importId: string }> },
): Promise<Response> {
  const { membership, response: membershipResponse } = await membershipOrResponse();
  if (membershipResponse) return membershipResponse;

  const originResponse = originFailure(request);
  if (originResponse) return originResponse;

  const key = idempotencyKey(request);
  if (!key) return fail("idempotency_key_required", "Idempotency-Key header is required", 422, false);

  const parsed = await parseBody(request, activateSchema);
  if (!parsed.success) return parsed.response;

  const { importId } = await context.params;
  if (!importIdSchema.safeParse(importId).success) {
    return fail("not_found", "Import was not found", 404, false);
  }

  try {
    const result = await activate({
      store: getImportStore(),
      orgId: membership!.orgId,
      userId: membership!.userId,
      role: membership!.role,
      importId,
      expectedVersion: parsed.data.expected_version,
      contactPermissionsConfirmed: parsed.data.contact_permissions_confirmed,
      idempotencyKey: key,
    });

    switch (result.outcome) {
      case "activated":
      case "already_active":
      case "noop_same_content":
        return ok({
          import_id: importId,
          dataset_id: result.dataset_id,
          status: "active",
          row_version: result.row_version,
          outcome: result.outcome,
        });
      case "not_found":
        return fail("not_found", "Import was not found", 404, false);
      case "version_conflict":
      case "invalid_state":
        return fail("conflict", "Import state changed; reload before retrying", 409, false);
      case "forbidden_contact_confirmation":
        return fail("forbidden_contact_confirmation", "Only an owner can confirm contact permissions", 403, false);
    }
  } catch {
    return fail("internal_error", "Import could not be activated", 500, true);
  }
}
