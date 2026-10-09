import "server-only";
import type { ActionRecord, ProviderAdapter } from "@/lib/actions/types";
import { registerAdapter } from "@/lib/actions/adapters";
import { createSupplierCallAdapter } from "./adapter";
import { getVoiceEnv, getVoiceProvider, getVoiceStore } from "./runtime";

function liveAdapter(): ProviderAdapter {
  return createSupplierCallAdapter({
    store: getVoiceStore(),
    provider: getVoiceProvider(),
    appEnv: getVoiceEnv().APP_ENV,
    now: () => new Date(),
  });
}

/** Registered lazily so importing this module never needs env or network. */
export const supplierCallAdapter: ProviderAdapter = {
  kind: "supplier_call",
  dispatch: (action: ActionRecord) => liveAdapter().dispatch(action),
  findResult: (action: ActionRecord) => liveAdapter().findResult(action),
};

registerAdapter(supplierCallAdapter);
