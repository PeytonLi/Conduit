import "server-only";
import "@/lib/integrations/register-providers";
import { inngest } from "@/lib/workflows/client";
import { publishAfterCommit, type PublishedEvent } from "@/lib/workflows/outbox";
import { registerF5Adapters } from "./adapters/index";
import type { DispatcherDeps } from "./dispatcher";
import { systemClock } from "./rpc";
import { createServiceRpc } from "./rpc.supabase";

export function serverLedger(): DispatcherDeps {
  const deps = { rpc: createServiceRpc(), clock: systemClock };
  registerF5Adapters(deps);
  return deps;
}

export const sendToInngest = async (events: PublishedEvent[]) => inngest.send(events);

export async function publishPending(deps: DispatcherDeps): Promise<void> {
  await publishAfterCommit({ ...deps, send: sendToInngest });
}
