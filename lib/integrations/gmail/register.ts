import { registerAdapter } from "@/lib/actions/adapters";
import {
  createSupplierEmailAdapter,
  type ContactRecord,
} from "@/lib/integrations/gmail/outbound";
import { createReplayTransport } from "@/lib/integrations/gmail/replay";

// Registers the supplier_email adapter. Registration is intentionally lazy
// about transports: no network and no env access happen until dispatch runs.
let registered = false;

export function ensureSupplierEmailAdapter(): void {
  if (registered) return;
  registered = true;
  registerAdapter(
    createSupplierEmailAdapter({
      appEnv: (process.env.APP_ENV as "replay" | "sandbox" | "live") ?? "replay",
      transportFor: () => null,
      loadContact: async (): Promise<ContactRecord | null> => null,
      fromAddressFor: () => "inbox@conduit.local",
      domain: "conduit.local",
      replayTransport: createReplayTransport(),
    }),
  );
}

ensureSupplierEmailAdapter();
