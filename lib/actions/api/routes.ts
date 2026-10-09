import "server-only";
import { requireMembership } from "@/lib/auth/membership";
import { publishPending, serverLedger } from "../server";
import type { HandlerDeps } from "./handlers";

export function routeDeps(): HandlerDeps {
  const ledger = serverLedger();
  return { ledger, auth: requireMembership, publish: () => publishPending(ledger) };
}
