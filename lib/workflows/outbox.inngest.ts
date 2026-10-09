import { serverLedger, sendToInngest } from "@/lib/actions/server";
import { inngest } from "./client";
import { drainOutbox } from "./outbox";

export const outboxDrain = inngest.createFunction(
  { id: "outbox-drain", triggers: [{ cron: "* * * * *" }], concurrency: { limit: 1 } },
  async ({ step }) => step.run("drain", async () => drainOutbox({ ...serverLedger(), send: sendToInngest }, 200)),
);
