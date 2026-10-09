import type { ActionRecord, DispatchResult, ProviderAdapter, ReconcileResult } from "@/lib/actions/types";
import type { VoiceStore } from "@/lib/db/voice-store";
import { buildCallBrief } from "./brief";
import {
  generateVoiceToken,
  hashVoiceToken,
  VOICE_GRANT_TTL_MS,
  VOICE_TOKEN_DYNAMIC_VARIABLE,
  VOICE_TOOL_NAMES,
} from "./capability";
import { classifyProviderError, type VoiceProviderClient } from "./client";
import { supplierCallPayloadSchema } from "./payload";

export interface SupplierCallAdapterDeps {
  store: VoiceStore;
  /** null when ElevenLabs is not configured; live/sandbox dispatch then fails closed. */
  provider: VoiceProviderClient | null;
  appEnv: "replay" | "sandbox" | "live";
  now: () => Date;
}

export const REPLAY_CONVERSATION_PREFIX = "replay-conv-";

const failed = (safeSummary: string): DispatchResult => ({ outcome: "failed", safeSummary });
const unknown = (safeSummary: string, providerRef?: string): DispatchResult => ({
  outcome: "unknown",
  safeSummary,
  ...(providerRef ? { providerRef } : {}),
});

export function createSupplierCallAdapter(deps: SupplierCallAdapterDeps): ProviderAdapter {
  const isReplay = (action: ActionRecord) => action.mode === "replay";

  async function dispatch(action: ActionRecord): Promise<DispatchResult> {
    if (action.kind !== "supplier_call") return failed("Not a supplier call action.");
    const payload = supplierCallPayloadSchema.safeParse(action.payload);
    if (!payload.success) return failed("Call payload is invalid; no call placed.");
    const payloadContactId = payload.data.contact_id ?? null;
    const actionContactId = action.contactId ?? null;
    if (payloadContactId && actionContactId && payloadContactId !== actionContactId) {
      return failed("Call payload contact does not match the action contact; no call placed.");
    }
    const contactId = actionContactId ?? payloadContactId;
    if (!contactId) return failed("Call payload has no contact; no call placed.");
    if (!isReplay(action) && (deps.appEnv === "replay" || !deps.provider)) {
      return failed("Live voice is not configured in this environment; no call placed.");
    }

    const context = await deps.store.callContext(action.orgId, action.id, contactId);
    if (!context || context.case_id !== action.caseId) return failed("Call target not found in this organization.");
    if (context.existing_call_session) {
      return unknown("A call was already attempted for this action; reconcile instead of redialing.");
    }
    if (context.run_control !== "active" || context.case_phase === "closed") {
      return failed(`Case is ${context.run_control === "active" ? "closed" : context.run_control}; no call placed.`);
    }
    if (context.contact_channel !== "phone" || !context.contact_phone_permitted) {
      return failed("Contact is not approved for phone outreach; no call placed.");
    }
    if (context.other_calls_in_flight > 0) {
      return failed("Another supplier call is in progress for this organization; no call placed.");
    }
    const brief = buildCallBrief({ actionId: action.id, context, payload: payload.data });
    if (!brief.ok) return failed(`Call brief incomplete (${brief.reason}); no call placed.`);

    const token = generateVoiceToken();
    const now = deps.now();
    const prepared = await deps.store.prepareCall({
      orgId: action.orgId,
      actionId: action.id,
      caseId: action.caseId,
      contactId: context.contact_id,
      tokenHash: hashVoiceToken(token),
      allowedTools: VOICE_TOOL_NAMES,
      expiresAt: new Date(now.getTime() + VOICE_GRANT_TTL_MS),
    });
    if (prepared.status === "already_attempted") {
      return unknown("A call was already attempted for this action; reconcile instead of redialing.");
    }
    if (prepared.status === "not_found") return failed("Call action not found; no call placed.");

    if (isReplay(action)) {
      const conversationId = `${REPLAY_CONVERSATION_PREFIX}${action.id}`;
      await deps.store.markCallStarted(action.orgId, action.id, conversationId, null, now);
      return {
        outcome: "submitted",
        providerRef: conversationId,
        safeSummary: "Replay: simulated supplier call started; no supplier was contacted.",
      };
    }

    let response;
    try {
      response = await deps.provider!.startOutboundCall({
        toNumber: context.contact_phone,
        dynamicVariables: { ...brief.variables, [VOICE_TOKEN_DYNAMIC_VARIABLE]: token },
      });
    } catch (error) {
      if (classifyProviderError(error) === "rejected") {
        await deps.store.revokeGrants(action.orgId, action.id, deps.now());
        return failed("Voice provider rejected the call request; no call placed.");
      }
      return unknown("Call start response was not received; the call may be in progress. Reconciling, not redialing.");
    }

    if (!response.success) {
      await deps.store.revokeGrants(action.orgId, action.id, deps.now());
      return failed("Voice provider did not start the call.");
    }
    const conversationId = response.conversationId ?? null;
    try {
      await deps.store.markCallStarted(action.orgId, action.id, conversationId, response.sipCallId ?? null, deps.now());
    } catch {
      return unknown("Call started but its identifiers could not be saved; reconciling.", conversationId ?? undefined);
    }
    if (!conversationId) {
      return unknown("Call started without a conversation ID; reconciling.");
    }
    return { outcome: "submitted", providerRef: conversationId, safeSummary: "Supplier call started." };
  }

  async function findResult(action: ActionRecord): Promise<ReconcileResult> {
    const stored = await deps.store.callOutcome(action.orgId, action.id);
    if (stored) {
      return {
        outcome: "confirmed",
        providerRef: stored.conversation_id,
        safeSummary: `Call finished: ${stored.outcome}.`,
      };
    }
    if (isReplay(action)) return { outcome: "unknown", safeSummary: "Replay call awaiting simulated callback." };
    if (!deps.provider) return { outcome: "unknown", safeSummary: "Voice provider not configured; cannot reconcile." };

    const session = await deps.store.callSession(action.orgId, action.id);
    if (!session) return { outcome: "failed", safeSummary: "No call attempt exists for this action." };
    const conversationId = session.conversation_id ?? action.providerRef;
    const sinceUnix = Math.floor(new Date(session.created_at).getTime() / 1000) - 60;
    const snapshot = conversationId
      ? await deps.provider.getConversation(conversationId)
      : await deps.provider.findConversationByActionId(action.id, sinceUnix);
    if (!snapshot) {
      return { outcome: "unknown", safeSummary: "No matching conversation found yet; needs reconciliation, not a redial." };
    }
    if (!session.conversation_id) {
      await deps.store.markCallStarted(action.orgId, action.id, snapshot.conversationId, snapshot.sipCallId, deps.now());
    }
    if (snapshot.status === "done" || snapshot.status === "failed") {
      return {
        outcome: "confirmed",
        providerRef: snapshot.conversationId,
        safeSummary: `Provider reports the call ${snapshot.status}; awaiting signed callback for details.`,
      };
    }
    return { outcome: "unknown", providerRef: snapshot.conversationId, safeSummary: "Call still in progress." };
  }

  return { kind: "supplier_call", dispatch, findResult };
}
