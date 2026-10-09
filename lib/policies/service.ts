import { callLedger, type Clock, type Rpc } from "@/lib/actions/rpc";
import { policySettingsSchema, type PolicySettings } from "./schema";

export function createPolicyVersion(
  deps: { rpc: Rpc; clock: Clock },
  input: { orgId: string; userId: string; expectedVersion: number; settings: PolicySettings; reason: string },
) {
  const settings = policySettingsSchema.parse(input.settings);
  return callLedger<{ policy_version_id: string; version: number }>(deps.rpc, "policy_create_version", {
    p_org_id: input.orgId,
    p_actor_user_id: input.userId,
    p_expected_version: input.expectedVersion,
    p_settings: settings,
    p_reason: input.reason,
    p_now: deps.clock.now().toISOString(),
  });
}
