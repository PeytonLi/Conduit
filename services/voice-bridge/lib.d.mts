export const SIGNATURE_MAX_AGE_SECONDS: number;
export function signPayload(rawBody: string, secret: string, timestampSeconds?: number): string;
export function verifySignature(
  rawBody: string,
  header: string | null,
  secret: string,
  nowMs?: number,
  maxAgeSeconds?: number,
): { ok: true; timestamp: number } | { ok: false; reason: string };
export function validateCallRequest(
  body: unknown,
  rawBody?: string,
):
  | { ok: true; value: { action_id: string; to: string; dynamic_variables: Record<string, string | number | boolean> } }
  | { ok: false; code: string };
export function parseAllowedTo(value: string | undefined): Set<string> | null;
export function isDestinationAllowed(to: string, allowlist: Set<string> | null): boolean;
export function createSession(input: { actionId: string; dynamicVariables: Record<string, string | number | boolean>; nowMs?: number }): {
  id: string;
  mediaKey: string;
  actionId: string;
  dynamicVariables: Record<string, string | number | boolean>;
  expiresAt: number;
  state: string;
  callSid: string | null;
  conversationId: string | null;
  streamActive: boolean;
  terminal: boolean;
};
export function validateStartEvent(
  session: ReturnType<typeof createSession> | null | undefined,
  customParameters: Record<string, string> | null,
  callSid: string,
  nowMs?: number,
): { ok: true } | { ok: false; code: string };
export function buildTwiML(publicUrl: string, session: ReturnType<typeof createSession>): string;
export function signalWireMediaToElevenLabs(message: unknown): { user_audio_chunk: string } | null;
export function translateAgentMessage(message: unknown, streamSid: string | null): {
  toCarrier?: Record<string, unknown>;
  toAgent?: Record<string, unknown>;
} | null;
export function conversationMetadata(message: unknown): {
  conversationId: string | null;
  userInputAudioFormat: string | null;
  agentOutputAudioFormat: string | null;
} | null;
export function hasSupportedAudioFormats(metadata: {
  userInputAudioFormat: string | null;
  agentOutputAudioFormat: string | null;
} | null): boolean;
export function shouldSendStatus(input: { conversationId: string | null; callStatus: string }): boolean;
