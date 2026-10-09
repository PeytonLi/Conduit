import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  conversationalAi: {
    secrets: { list: vi.fn(async () => ({ secrets: [{ name: "conduit_deepseek_api_key", secretId: "secret_test" }] })) },
    tools: {
      list: vi.fn(async () => ({ tools: [] })),
      create: vi.fn(async () => ({ id: "tool_test" })),
    },
    agents: { update: vi.fn(async () => ({})) },
    phoneNumbers: {
      list: vi.fn(async () => [{ provider: "sip_trunk", phoneNumber: "+15551234567", phoneNumberId: "phone_existing" }]),
      create: vi.fn(),
      update: vi.fn(async () => ({})),
    },
  },
  webhooks: { list: vi.fn(async () => ({ webhooks: [{ webhookUrl: "https://conduit.example/api/webhooks/elevenlabs", webhookId: "hook_test" }] })) },
}));

vi.mock("@elevenlabs/elevenlabs-js", () => ({
  ElevenLabsClient: class { constructor() { return api; } },
}));

const originalArgv = process.argv;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  for (const [name, value] of Object.entries({
    APP_BASE_URL: "https://conduit.example",
    DEEPSEEK_API_KEY: "test-deepseek-key",
    DEEPSEEK_MODEL: "deepseek-chat",
    DEEPSEEK_BASE_URL: "https://api.deepseek.com",
    ELEVENLABS_API_KEY: "test-elevenlabs-key",
    ELEVENLABS_AGENT_ID: "agent_test",
    SIGNALWIRE_PHONE_NUMBER: "+15551234567",
    SIGNALWIRE_SIP_ADDRESS: "conduit.dapp.signalwire.com",
    SIGNALWIRE_SIP_USERNAME: "+15551234567",
    SIGNALWIRE_SIP_PASSWORD: "test-password",
  })) vi.stubEnv(name, value);
  process.argv = ["node", "setup-agent.ts", "--apply"];
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  process.argv = originalArgv;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("rerunning setup updates the existing SIP trunk instead of keeping its broken route", async () => {
  await import("@/scripts/voice/setup-agent");

  await vi.waitFor(() => expect(api.conversationalAi.phoneNumbers.update).toHaveBeenCalledWith("phone_existing", {
    agentId: "agent_test",
    outboundTrunkConfig: {
      address: "conduit.dapp.signalwire.com",
      transport: "tls",
      credentials: { username: "+15551234567", password: "test-password" },
    },
  }));
  expect(api.conversationalAi.phoneNumbers.create).not.toHaveBeenCalled();
});

it("rejects the wrong SIP domain before writing any provider configuration", async () => {
  vi.stubEnv("SIGNALWIRE_SIP_ADDRESS", "example.sip.signalwire.com");
  const exit = vi.spyOn(process, "exit").mockReturnValue(undefined as never);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});

  await import("@/scripts/voice/setup-agent");

  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  expect(error).toHaveBeenCalledWith(expect.stringMatching(/Domain Application/));
  expect(api.conversationalAi.secrets.list).not.toHaveBeenCalled();
  expect(api.conversationalAi.phoneNumbers.update).not.toHaveBeenCalled();
});
