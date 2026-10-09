import type { SupabaseClient } from "@supabase/supabase-js";
import type { VoiceStore } from "./voice-store";

async function rpc<T>(client: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.rpc(fn, args);
  if (error) {
    throw new Error(`voice store ${fn} failed: ${error.code ?? "unknown"}`);
  }
  return data as T;
}

/** Service-role backed store. Only server code may construct this. */
export function createSupabaseVoiceStore(client: SupabaseClient): VoiceStore {
  return {
    callContext: (orgId, actionId, contactId) =>
      rpc(client, "voice_call_context", { p_org_id: orgId, p_action_id: actionId, p_contact_id: contactId }),
    prepareCall: (i) =>
      rpc(client, "voice_prepare_call", {
        p_org_id: i.orgId,
        p_action_id: i.actionId,
        p_case_id: i.caseId,
        p_contact_id: i.contactId,
        p_token_hash: i.tokenHash,
        p_allowed_tools: i.allowedTools,
        p_expires_at: i.expiresAt.toISOString(),
      }),
    markCallStarted: async (orgId, actionId, conversationId, sipCallId, at) => {
      await rpc(client, "voice_mark_call_started", {
        p_org_id: orgId,
        p_action_id: actionId,
        p_conversation_id: conversationId,
        p_sip_call_id: sipCallId,
        p_started_at: at.toISOString(),
      });
    },
    revokeGrants: async (orgId, actionId, at) => {
      await rpc(client, "voice_revoke_grants", { p_org_id: orgId, p_action_id: actionId, p_at: at.toISOString() });
    },
    resolveGrant: (tokenHash) => rpc(client, "voice_resolve_grant", { p_token_hash: tokenHash }),
    caseFacts: (orgId, caseId, contactId) =>
      rpc(client, "voice_case_facts", { p_org_id: orgId, p_case_id: caseId, p_contact_id: contactId }),
    offerContext: (orgId, caseId, contactId) =>
      rpc(client, "voice_offer_context", { p_org_id: orgId, p_case_id: caseId, p_contact_id: contactId }),
    recordToolEvent: async (i) => {
      await rpc(client, "voice_record_tool_event", {
        p_org_id: i.orgId,
        p_case_id: i.caseId,
        p_action_id: i.actionId,
        p_tool: i.tool,
        p_result_code: i.resultCode,
        p_payload: i.payload,
        p_at: i.at.toISOString(),
      });
    },
    createOwnerTask: (i) =>
      rpc(client, "voice_create_owner_task", {
        p_org_id: i.orgId,
        p_case_id: i.caseId,
        p_action_id: i.actionId,
        p_kind: i.kind,
        p_reason: i.reason,
        p_detail: i.detail,
        p_at: i.at.toISOString(),
      }),
    recordProvisionalOffer: (input) => rpc(client, "voice_record_provisional_offer", { p: input }),
    callbackLink: (conversationId, actionHint) =>
      rpc(client, "voice_callback_link", { p_conversation_id: conversationId, p_action_hint: actionHint }),
    recordCallback: (input) => rpc(client, "voice_record_callback", { p: input }),
    callOutcome: (orgId, actionId) => rpc(client, "voice_call_outcome", { p_org_id: orgId, p_action_id: actionId }),
    callSession: (orgId, actionId) => rpc(client, "voice_call_session", { p_org_id: orgId, p_action_id: actionId }),
    flagStaleCalls: (now, graceSeconds) =>
      rpc(client, "voice_flag_stale_calls", { p_now: now.toISOString(), p_grace_seconds: graceSeconds }),
  };
}
