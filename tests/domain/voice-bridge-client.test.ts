import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyProviderError, ProviderHttpError } from "@/lib/integrations/elevenlabs/client";
import { createBridgeVoiceClient, signBridgeRequest } from "@/lib/integrations/elevenlabs/bridge-client";

describe("media bridge provider client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("signs the exact request body and maps a call SID", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.headers).toMatchObject({ "x-conduit-signature": expect.stringMatching(/^t=\d+,v0=[0-9a-f]{64}$/) });
      expect(JSON.parse(String(init.body))).toEqual({
        action_id: "60000000-0000-4000-8000-000000000001",
        to: "+15555550100",
        dynamic_variables: { conduit_action_id: "60000000-0000-4000-8000-000000000001", qty: 4 },
      });
      return new Response(JSON.stringify({ call_sid: "CA_bridge" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = createBridgeVoiceClient({
      bridgeUrl: "https://bridge.example.test/",
      secret: "12345678901234567890123456789012",
      apiKey: "api-key",
    });
    const result = await client.startOutboundCall({
      toNumber: "+15555550100",
      dynamicVariables: { conduit_action_id: "60000000-0000-4000-8000-000000000001", qty: 4 },
    });
    expect(result).toMatchObject({ success: true, sipCallId: "CA_bridge" });
    expect(client.transport).toBe("media_bridge");
    expect(signBridgeRequest("{}", "secret", 10)).toMatch(/^t=10,v0=[0-9a-f]{64}$/);
  });

  it("classifies bridge HTTP errors and malformed successes as ambiguous or rejected", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 422 })));
    const client = createBridgeVoiceClient({ bridgeUrl: "https://bridge.example.test", secret: "12345678901234567890123456789012", apiKey: "key" });
    await expect(client.startOutboundCall({ toNumber: "+15555550100", dynamicVariables: { conduit_action_id: "60000000-0000-4000-8000-000000000001" } })).rejects.toBeInstanceOf(ProviderHttpError);
    expect(classifyProviderError(new ProviderHttpError("bad", 422))).toBe("rejected");
    expect(classifyProviderError(new ProviderHttpError("bad", 502))).toBe("ambiguous");
  });
});
