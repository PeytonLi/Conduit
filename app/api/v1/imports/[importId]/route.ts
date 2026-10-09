import { fail, ok } from "@/lib/api/http";
import { getImportStore } from "@/lib/db/imports";
import { getImport } from "@/lib/db/imports/service";
import { z } from "zod";
import { membershipOrResponse } from "../_shared";

const importIdSchema = z.string().uuid();

export async function GET(
  _request: Request,
  context: { params: Promise<{ importId: string }> },
): Promise<Response> {
  const { membership, response: membershipResponse } = await membershipOrResponse();
  if (membershipResponse) return membershipResponse;

  const { importId } = await context.params;
  if (!importIdSchema.safeParse(importId).success) {
    return fail("not_found", "Import was not found", 404, false);
  }

  try {
    const result = await getImport({
      store: getImportStore(),
      orgId: membership!.orgId,
      importId,
    });
    if (!result) return fail("not_found", "Import was not found", 404, false);
    return ok(result);
  } catch {
    return fail("internal_error", "Import could not be loaded", 500, true);
  }
}
