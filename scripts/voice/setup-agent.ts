/**
 * Idempotently creates/updates the Conduit supplier-call agent in ElevenLabs.
 * Prints only provider IDs, never secrets. Never places a call.
 *
 *   pnpm tsx scripts/voice/setup-agent.ts            # dry run: prints the plan
 *   pnpm tsx scripts/voice/setup-agent.ts --apply    # writes to ElevenLabs
 *
 * Required env: ELEVENLABS_API_KEY, APP_BASE_URL (public https URL), DEEPSEEK_API_KEY, DEEPSEEK_MODEL.
 * Optional: DEEPSEEK_BASE_URL (default https://api.deepseek.com), ELEVENLABS_AGENT_ID (update this agent),
 * SIGNALWIRE_PHONE_NUMBER + SIGNALWIRE_SIP_ADDRESS + SIGNALWIRE_SIP_USERNAME + SIGNALWIRE_SIP_PASSWORD
 * (import the SignalWire SIP trunk number and assign the agent).
 */
import { ElevenLabsClient, type ElevenLabs } from "@elevenlabs/elevenlabs-js";
import { VOICE_TOKEN_DYNAMIC_VARIABLE, VOICE_TOKEN_HEADER, type VoiceToolName } from "@/lib/integrations/elevenlabs/capability";
import { SUPPLIER_CALL_FIRST_MESSAGE, SUPPLIER_CALL_PROMPT, SUPPLIER_CALL_PROMPT_VERSION } from "@/lib/integrations/elevenlabs/prompt";
import { buildElevenLabsSipTrunkRequest } from "@/lib/integrations/signalwire/sip";

const AGENT_NAME = "Conduit supplier call";
const TOOL_PREFIX = "conduit_";
const WEBHOOK_NAME = "Conduit post-call";
const DEEPSEEK_SECRET_NAME = "conduit_deepseek_api_key";

type Prop = ElevenLabs.ObjectJsonSchemaPropertyInput["properties"];
const s = (description: string) => ({ type: "string" as const, description });
const offerProps: Prop = {
  quantity: { type: "integer", description: "Units the supplier can provide" },
  currency: s("ISO currency code, e.g. USD"),
  unit_price: s("Unit price as a plain decimal string, e.g. 1.30"),
  freight: s("Freight charge as a plain decimal string"),
  fees: s("Other fees as a plain decimal string"),
  arrival_date: s("Arrival date at destination, YYYY-MM-DD"),
  quote_valid_until: s("Quote validity date, YYYY-MM-DD"),
  order_cutoff: s("Latest order date/time for that arrival, ISO 8601"),
  split_delivery: { type: "boolean", description: "Can the delivery be split" },
  supplier_confirmed_readback: { type: "boolean", description: "Supplier confirmed the repeated terms" },
  notes: s("Short factual note of supplier caveats"),
};

const TOOLS: Record<VoiceToolName, { description: string; properties: Prop; required: string[] }> = {
  read_case_facts: { description: "Read the order and shortage facts for this call.", properties: {}, required: [] },
  validate_offer: { description: "Check stated terms for missing fields and fit. Does not accept anything.", properties: offerProps, required: ["quantity"] },
  record_provisional_offer: { description: "Record confirmed terms as a provisional quote pending owner approval.", properties: offerProps, required: ["quantity"] },
  request_written_confirmation: { description: "Ask that the terms be confirmed in writing by email.", properties: { email_on_file_ok: { type: "boolean", description: "Supplier agreed to email confirmation" }, notes: s("Short note") }, required: [] },
  request_human_review: { description: "Escalate to the business owner.", properties: { reason: { type: "string", description: "Why", enum: ["supplier_requested_human", "unclear_terms", "legal_or_contract", "safety", "case_paused", "other"] }, notes: s("Short note") }, required: ["reason"] },
  end_call: { description: "Log that the call is ending (then use the built-in end_call).", properties: { reason: { type: "string", description: "Why", enum: ["completed", "voicemail", "wrong_contact", "supplier_declined", "case_paused", "other"] } }, required: ["reason"] },
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env ${name}`);
  return value;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const baseUrl = requireEnv("APP_BASE_URL").replace(/\/$/, "");
  if (!baseUrl.startsWith("https://")) throw new Error("APP_BASE_URL must be a public https URL");
  const deepseekBase = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
  const deepseekModel = requireEnv("DEEPSEEK_MODEL");
  requireEnv("DEEPSEEK_API_KEY");
  if (!apply) {
    console.log(JSON.stringify({ dryRun: true, agent: AGENT_NAME, promptVersion: SUPPLIER_CALL_PROMPT_VERSION, tools: Object.keys(TOOLS), webhookUrl: `${baseUrl}/api/webhooks/elevenlabs`, llm: `${deepseekBase} (${deepseekModel})` }, null, 2));
    return;
  }
  const client = new ElevenLabsClient({ apiKey: requireEnv("ELEVENLABS_API_KEY") });
  const ids: Record<string, string> = {};

  // 1. DeepSeek key as a workspace secret (value is never printed).
  const secrets = await client.conversationalAi.secrets.list();
  const existingSecret = secrets.secrets.find((secret) => secret.name === DEEPSEEK_SECRET_NAME);
  const secretId = existingSecret
    ? existingSecret.secretId
    : (await client.conversationalAi.secrets.create({ name: DEEPSEEK_SECRET_NAME, value: requireEnv("DEEPSEEK_API_KEY") })).secretId;
  ids.deepseekSecretId = secretId;

  // 2. Webhook tools; the per-call capability travels only in a header from a secret__ dynamic variable.
  const existingTools = (await client.conversationalAi.tools.list({ search: TOOL_PREFIX, pageSize: 100 })).tools;
  const toolIds: string[] = [];
  for (const [name, def] of Object.entries(TOOLS)) {
    const request: ElevenLabs.ToolRequestModel = {
      toolConfig: {
        type: "webhook",
        name: `${TOOL_PREFIX}${name}`,
        description: def.description,
        responseTimeoutSecs: 10,
        apiSchema: {
          url: `${baseUrl}/api/voice/tools/${name}`,
          method: "POST",
          requestHeaders: { [VOICE_TOKEN_HEADER]: { variableName: VOICE_TOKEN_DYNAMIC_VARIABLE } },
          requestBodySchema: { type: "object", properties: def.properties, required: def.required },
        },
      },
    };
    const found = existingTools.find((tool) => (tool.toolConfig as { name?: string }).name === `${TOOL_PREFIX}${name}`);
    const saved = found ? await client.conversationalAi.tools.update(found.id, request) : await client.conversationalAi.tools.create(request);
    toolIds.push(saved.id);
    ids[`tool_${name}`] = saved.id;
  }

  // 3. Signed post-call webhook. The HMAC secret is shown once by ElevenLabs on creation.
  const webhookUrl = `${baseUrl}/api/webhooks/elevenlabs`;
  const hooks = await client.webhooks.list();
  let webhookId = hooks.webhooks?.find((hook) => hook.webhookUrl === webhookUrl)?.webhookId;
  if (!webhookId) {
    const created = await client.webhooks.create({ settings: { authType: "hmac", name: WEBHOOK_NAME, webhookUrl } });
    webhookId = created.webhookId;
    console.log("Created post-call webhook. Copy its signing secret from the ElevenLabs dashboard into ELEVENLABS_WEBHOOK_SECRET (not printed here).");
  }
  ids.postCallWebhookId = webhookId;

  // 4. Agent with DeepSeek as a custom OpenAI-compatible LLM (streaming chat completions).
  const conversationConfig: ElevenLabs.ConversationalConfig = {
    agent: {
      firstMessage: SUPPLIER_CALL_FIRST_MESSAGE,
      prompt: {
        prompt: SUPPLIER_CALL_PROMPT,
        llm: "custom-llm",
        customLlm: { url: `${deepseekBase}/v1`, modelId: deepseekModel, apiKey: { secretId }, apiType: "chat_completions" },
        toolIds,
        builtInTools: {
          endCall: { name: "end_call", params: { systemToolType: "end_call" } },
          voicemailDetection: { name: "voicemail_detection", params: { systemToolType: "voicemail_detection" } },
        },
      },
    },
    conversation: { maxDurationSeconds: 300 },
  };
  const platformSettings: ElevenLabs.AgentPlatformSettingsRequestModel = {
    workspaceOverrides: { webhooks: { postCallWebhookId: webhookId, events: ["transcript", "call_initiation_failure"], sendAudio: false } },
  };
  let agentId = process.env.ELEVENLABS_AGENT_ID || (await client.conversationalAi.agents.list({ search: AGENT_NAME })).agents.find((agent) => agent.name === AGENT_NAME)?.agentId;
  if (agentId) {
    await client.conversationalAi.agents.update(agentId, { name: AGENT_NAME, conversationConfig, platformSettings, tags: [SUPPLIER_CALL_PROMPT_VERSION] });
  } else {
    agentId = (await client.conversationalAi.agents.create({ name: AGENT_NAME, conversationConfig, platformSettings, tags: [SUPPLIER_CALL_PROMPT_VERSION] })).agentId;
  }
  ids.agentId = agentId;

  // 5. Optional: import the SignalWire number as an ElevenLabs SIP trunk number and assign the agent.
  if (process.env.SIGNALWIRE_PHONE_NUMBER && process.env.SIGNALWIRE_SIP_ADDRESS) {
    const numbers = await client.conversationalAi.phoneNumbers.list();
    const existing = numbers.find((n) => n.phoneNumber === process.env.SIGNALWIRE_PHONE_NUMBER);
    const phoneNumberId = existing
      ? existing.phoneNumberId
      : (await client.conversationalAi.phoneNumbers.create(
          buildElevenLabsSipTrunkRequest({
            phoneNumber: process.env.SIGNALWIRE_PHONE_NUMBER,
            sipAddress: process.env.SIGNALWIRE_SIP_ADDRESS,
            username: requireEnv("SIGNALWIRE_SIP_USERNAME"),
            password: requireEnv("SIGNALWIRE_SIP_PASSWORD"),
          }),
        )).phoneNumberId;
    await client.conversationalAi.phoneNumbers.update(phoneNumberId, { agentId });
    ids.phoneNumberId = phoneNumberId;
  }

  console.log(JSON.stringify(ids, null, 2));
}

main().catch((error: unknown) => {
  console.error(`setup-agent failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exit(1);
});
