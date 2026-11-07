import { registerAdapter } from "@/lib/actions/adapters";
import { registerLiveStepPreparer } from "@/lib/actions/live-step";
import { systemClock } from "@/lib/actions/rpc";
import { createServiceRpc } from "@/lib/actions/rpc.supabase";
import { parseServerEnv } from "@/lib/env";
import { createLiveBusinessAdapter } from "./adapter";
import { prepareLiveStepPayload } from "./prepare";
import { ensureErpProviders } from "./providers";
import { resolveErpClient } from "./resolve";

// Live business-system writes are sandbox/live only: the adapter goes in the normal
// registry, never the replay registry. No env, DB or network access at import time.
let registered = false;

export function ensureLiveBusinessConnector(): void {
  if (registered) return;
  registered = true;
  ensureErpProviders();
  const resolve = (orgId: string, connectionId?: string) =>
    resolveErpClient(
      { rpc: createServiceRpc(), encryptionKey: parseServerEnv(process.env).CREDENTIAL_ENCRYPTION_KEY },
      orgId,
      connectionId,
    );
  registerAdapter(createLiveBusinessAdapter({ resolve: (action, connectionId) => resolve(action.orgId, connectionId) }));
  registerLiveStepPreparer((input) =>
    prepareLiveStepPayload({ rpc: createServiceRpc(), clock: systemClock, resolve: (orgId) => resolve(orgId) }, input),
  );
}

ensureLiveBusinessConnector();
