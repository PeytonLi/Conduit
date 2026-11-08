import { registerAdapter } from "@/lib/actions/adapters";
import { registerLiveStepPreparer, registerTransferGate } from "@/lib/actions/live-step";
import { systemClock } from "@/lib/actions/rpc";
import { createServiceRpc } from "@/lib/actions/rpc.supabase";
import { parseServerEnv } from "@/lib/env";
import { createLiveBusinessAdapter } from "./adapter";
import { prepareLiveStepPayload } from "./prepare";
import { prepareLiveTransferPayload } from "./prepare-transfer";
import { ensureErpProviders } from "./providers";
import { resolveErpClient } from "./resolve";
import { evaluateTransferGate } from "./transfer-gate";
import { createLiveTransferAdapter } from "./transfer-adapter";

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
  registerAdapter(createLiveTransferAdapter({ resolve: (action, connectionId) => resolve(action.orgId, connectionId) }));
  registerLiveStepPreparer(async (input) => {
    const deps = { rpc: createServiceRpc(), clock: systemClock, resolve: (orgId: string) => resolve(orgId) };
    if (input.step?.kind === "transfer_stock") {
      const prepared = await prepareLiveTransferPayload(deps, { ...input, step: input.step });
      return prepared.ok ? { ok: true, payload: prepared.payload, kind: "live_business_transfer" } : prepared;
    }
    return prepareLiveStepPayload(deps, input);
  });
  registerTransferGate((orgId) => evaluateTransferGate((id) => resolve(id), orgId));
}

ensureLiveBusinessConnector();
