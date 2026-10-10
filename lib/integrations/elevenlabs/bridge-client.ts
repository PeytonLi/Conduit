import { createHmac } from "node:crypto";
import {
  createElevenLabsConversationReader,
  ProviderHttpError,
  type OutboundCallRequest,
  type OutboundCallResponse,
  type VoiceProviderClient,
} from "./client";

export interface BridgeVoiceConfig {
  bridgeUrl: string;
  secret: string;
  apiKey: string;
  agentId?: string;
  timeoutSeconds?: number;
}

export function signBridgeRequest(rawBody: string, secret: string, timestampSeconds: number): string {
  const digest = createHmac("sha256", secret).update(`${timestampSeconds}.${rawBody}`, "utf8").digest("hex");
  return `t=${timestampSeconds},v0=${digest}`;
}

export function createBridgeVoiceClient(config: BridgeVoiceConfig): VoiceProviderClient {
  const reader = config.agentId
    ? createElevenLabsConversationReader({ apiKey: config.apiKey, agentId: config.agentId })
    : {
        async getConversation() {
          return null;
        },
        async findConversationByActionId() {
          return null;
        },
      };
  const baseUrl = config.bridgeUrl.replace(/\/+$/, "");
  const timeoutMs = (config.timeoutSeconds ?? 20) * 1000;

  return {
    transport: "media_bridge",
    ...reader,
    async startOutboundCall(request: OutboundCallRequest): Promise<OutboundCallResponse> {
      const rawBody = JSON.stringify({
        action_id: request.dynamicVariables.conduit_action_id,
        to: request.toNumber,
        dynamic_variables: request.dynamicVariables,
      });
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = signBridgeRequest(rawBody, config.secret, timestamp);
      const response = await fetch(`${baseUrl}/calls`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-conduit-signature": signature,
        },
        body: rawBody,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new ProviderHttpError("Voice bridge rejected the call request.", response.status);
      const body = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new ProviderHttpError("Voice bridge returned an invalid response.", response.status);
      }
      const callSid = parsed && typeof parsed === "object" && typeof (parsed as { call_sid?: unknown }).call_sid === "string"
        ? (parsed as { call_sid: string }).call_sid
        : null;
      if (!callSid) throw new ProviderHttpError("Voice bridge returned no call SID.", response.status);
      return { success: true, message: "Voice bridge call submitted.", sipCallId: callSid };
    },
  };
}
