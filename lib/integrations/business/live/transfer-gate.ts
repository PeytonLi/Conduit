import type { TransferGateResult } from "@/lib/actions/live-step";
import { transferCapabilityBlockers } from "@/lib/domain/transfers";
import type { ResolvedErpClient } from "./resolve";
import { transferSupportFor } from "./transfer-support";

/**
 * Decides, from the connected business system, whether an approved transfer can be executed
 * or must stay a recommendation. Never throws for missing setup: the reason is shown to the owner.
 */
export async function evaluateTransferGate(
  resolve: (orgId: string) => Promise<ResolvedErpClient>,
  orgId: string,
): Promise<TransferGateResult> {
  const resolved = await resolve(orgId);
  if (resolved.status !== "ready") {
    return { mode: "recommend_only", provider: resolved.connection?.provider ?? null, code: resolved.status, reason: resolved.reason };
  }
  const provider = resolved.connection.provider;
  const support = transferSupportFor(provider);
  if (support.mode === "recommend_only") {
    return { mode: "recommend_only", provider, code: "provider_unsupported", reason: support.reason };
  }
  const api = resolved.client.transfers;
  if (!api) {
    return {
      mode: "recommend_only",
      provider,
      code: "transfer_permission_missing",
      reason: `The ${provider} connection was not granted permission to create transfers; reconnect it with transfer permission to execute transfers.`,
    };
  }
  const blockers = transferCapabilityBlockers(api.capabilities);
  if (blockers.length > 0) {
    return { mode: "recommend_only", provider, code: "capability_missing", reason: `The ${provider} connector lacks: ${blockers.join(", ")}.` };
  }
  return { mode: "execute", provider, connectionId: resolved.connection.connectionId };
}
