import { createServiceClient } from "@/lib/db/service";
import { inngest } from "./client";

export const expireEvidenceSources = inngest.createFunction(
  {
    id: "expire-evidence-sources",
    triggers: [{ cron: "0 2 * * *" }],
    concurrency: { limit: 1 },
  },
  async ({ step }) => {
    const client = createServiceClient();
    const paths = await step.run("tombstone-expired-evidence", async () => {
      const { data, error } = await client.rpc("expire_evidence_sources", {
        p_now: new Date().toISOString(),
      });
      if (error) throw new Error("Evidence expiry failed");
      return (data ?? []) as { storage_path: string }[];
    });
    const storagePaths = paths.map((row) => row.storage_path).filter(Boolean);
    if (storagePaths.length === 0) return { expired: 0, deleted: 0 };
    const result = await step.run("delete-expired-evidence-objects", async () => {
      const { error } = await client.storage.from("evidence").remove(storagePaths);
      if (error) throw new Error("Expired evidence object cleanup failed");
      return storagePaths.length;
    });
    return { expired: paths.length, deleted: result };
  },
);
