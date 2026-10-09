import { createServiceClient } from "@/lib/db/service";
import { QueryError, type QueryContext } from "./client";

export interface EvidenceAccess {
  url: string;
  expires_at: string;
}

export async function getEvidenceAccess(
  context: QueryContext,
  evidenceId: string,
  now: Date = new Date(),
): Promise<EvidenceAccess> {
  const client = createServiceClient();
  const { data, error } = await client.from("evidence")
    .select("id,private_object_path")
    .eq("org_id", context.orgId)
    .eq("id", evidenceId)
    .maybeSingle();
  if (error) {
    throw new QueryError("query_failed", 503, "Evidence access is temporarily unavailable");
  }
  if (!data) {
    throw new QueryError("evidence_file_unavailable", 404, "Evidence file is unavailable");
  }
  if (!data.private_object_path) {
    throw new QueryError("evidence_file_unavailable", 404, "Evidence file is unavailable");
  }
  const { data: signed, error: storageError } = await client.storage
    .from("evidence")
    .createSignedUrl(data.private_object_path, 300);
  if (storageError || !signed?.signedUrl) {
    throw new QueryError("evidence_file_unavailable", 404, "Evidence file is unavailable");
  }
  return {
    url: signed.signedUrl,
    expires_at: new Date(now.getTime() + 300_000).toISOString(),
  };
}
