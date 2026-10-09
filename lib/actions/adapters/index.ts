import { createDemoLedgerConnector } from "@/lib/integrations/business/demo-ledger";
import { registerAdapter } from "../adapters";
import { registerReplayAdapter } from "../replay";
import type { Clock, Rpc } from "../rpc";
import { createDemoLedgerAdapter } from "./demo-ledger";
import { createManualExportAdapter } from "./manual-export";
import { createReplayOutreachAdapter } from "./replay-outreach";

let registered = false;

/**
 * Registers F5's adapters. Replay-safe adapters go in the replay registry; the demo ledger and
 * manual export adapters are also the sandbox adapters for their kinds. Live email/call adapters
 * are registered by their owning features through registerAdapter.
 */
export function registerF5Adapters(deps: { rpc: Rpc; clock: Clock }): void {
  if (registered) return;
  registered = true;
  const demo = createDemoLedgerAdapter(createDemoLedgerConnector(deps));
  const manual = createManualExportAdapter();
  registerReplayAdapter(createReplayOutreachAdapter("supplier_email"));
  registerReplayAdapter(createReplayOutreachAdapter("supplier_call"));
  registerReplayAdapter(demo);
  registerReplayAdapter(manual);
  registerAdapter(demo);
  registerAdapter(manual);
}
