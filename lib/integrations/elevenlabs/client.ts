import { ElevenLabsClient, ElevenLabsError } from "@elevenlabs/elevenlabs-js";

export interface OutboundCallRequest {
  toNumber: string;
  dynamicVariables: Record<string, string | number | boolean>;
}

export interface OutboundCallResponse {
  success: boolean;
  message: string;
  conversationId?: string;
  sipCallId?: string;
}

export type VoiceTransport = "sip_trunk" | "media_bridge";

export interface ConversationSnapshot {
  conversationId: string;
  status: string;
  terminationReason: string | null;
  callDurationSecs: number | null;
  actionId: string | null;
  sipCallId: string | null;
}

/** Narrow provider seam so the adapter can be tested with a fake that never dials. */
export interface VoiceProviderClient {
  readonly transport: VoiceTransport;
  startOutboundCall(request: OutboundCallRequest): Promise<OutboundCallResponse>;
  getConversation(conversationId: string): Promise<ConversationSnapshot | null>;
  findConversationByActionId(actionId: string, sinceUnixSeconds: number): Promise<ConversationSnapshot | null>;
}

export class ProviderHttpError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "ProviderHttpError";
    this.statusCode = statusCode;
  }
}

/**
 * A definite rejection (4xx other than timeout/conflict/rate-limit) means no call was placed.
 * Everything else (timeouts, network errors, 5xx) is ambiguous: the call may be ringing.
 */
export function classifyProviderError(error: unknown): "rejected" | "ambiguous" {
  const code =
    error instanceof ElevenLabsError || error instanceof ProviderHttpError
      ? error.statusCode
      : undefined;
  if (typeof code === "number") {
    if (code >= 400 && code < 500 && code !== 408 && code !== 409 && code !== 429) return "rejected";
  }
  return "ambiguous";
}

type Loose = Record<string, unknown>;
const asRecord = (value: unknown): Loose => (value && typeof value === "object" ? (value as Loose) : {});
const asString = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

function toSnapshot(raw: unknown): ConversationSnapshot | null {
  const conversation = asRecord(raw);
  const conversationId = asString(conversation.conversationId);
  if (!conversationId) return null;
  const metadata = asRecord(conversation.metadata);
  const phoneCall = asRecord(metadata.phoneCall);
  const variables = asRecord(asRecord(conversation.conversationInitiationClientData).dynamicVariables);
  return {
    conversationId,
    status: asString(conversation.status) ?? "unknown",
    terminationReason: asString(metadata.terminationReason),
    callDurationSecs: typeof metadata.callDurationSecs === "number" ? metadata.callDurationSecs : null,
    actionId: asString(variables.conduit_action_id),
    sipCallId: asString(phoneCall.callSid) ?? asString(phoneCall.callId),
  };
}

export interface ElevenLabsVoiceConfig {
  apiKey: string;
  agentId: string;
  phoneNumberId: string;
  timeoutSeconds?: number;
  ringingTimeoutSecs?: number;
}

export interface ElevenLabsConversationReader {
  getConversation(conversationId: string): Promise<ConversationSnapshot | null>;
  findConversationByActionId(actionId: string, sinceUnixSeconds: number): Promise<ConversationSnapshot | null>;
}

export function createElevenLabsConversationReader(config: {
  apiKey: string;
  agentId: string;
}): ElevenLabsConversationReader {
  const client = new ElevenLabsClient({ apiKey: config.apiKey });
  const readOptions = { timeoutInSeconds: 15, maxRetries: 2 };

  return {
    async getConversation(conversationId) {
      try {
        return toSnapshot(await client.conversationalAi.conversations.get(conversationId, {}, readOptions));
      } catch (error) {
        if (error instanceof ElevenLabsError && error.statusCode === 404) return null;
        throw error;
      }
    },
    async findConversationByActionId(actionId, sinceUnixSeconds) {
      const page = await client.conversationalAi.conversations.list(
        { agentId: config.agentId, callStartAfterUnix: sinceUnixSeconds, pageSize: 20 },
        readOptions,
      );
      for (const summary of page.conversations ?? []) {
        const snapshot = await this.getConversation(summary.conversationId);
        if (snapshot?.actionId === actionId) return snapshot;
      }
      return null;
    },
  };
}

export function createElevenLabsVoiceClient(config: ElevenLabsVoiceConfig): VoiceProviderClient {
  const client = new ElevenLabsClient({ apiKey: config.apiKey });
  const reader = createElevenLabsConversationReader(config);
  // Never let the SDK retry a call start: a retry could place a second call.
  const startOptions = { timeoutInSeconds: config.timeoutSeconds ?? 20, maxRetries: 0 };

  return {
    transport: "sip_trunk",
    ...reader,
    async startOutboundCall(request) {
      const response = await client.conversationalAi.sipTrunk.outboundCall(
        {
          agentId: config.agentId,
          agentPhoneNumberId: config.phoneNumberId,
          toNumber: request.toNumber,
          conversationInitiationClientData: { dynamicVariables: request.dynamicVariables },
          telephonyCallConfig: { ringingTimeoutSecs: config.ringingTimeoutSecs ?? 45 },
        },
        startOptions,
      );
      return {
        success: response.success,
        message: response.message,
        conversationId: response.conversationId ?? undefined,
        sipCallId: response.sipCallId ?? undefined,
      };
    },
  };
}
