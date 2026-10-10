import { describe, expect, it } from "vitest";
import { buildElevenLabsSipTrunkRequest } from "@/lib/integrations/signalwire/sip";

const config = {
  phoneNumber: "+15551234567",
  sipAddress: "conduit.dapp.signalwire.com",
  username: "+15551234567",
  password: "test-password",
};

describe("SignalWire SIP termination configuration", () => {
  it("keeps TLS for a bare termination hostname", () => {
    expect(buildElevenLabsSipTrunkRequest(config).outboundTrunkConfig).toMatchObject({
      address: config.sipAddress,
      transport: "tls",
      credentials: { username: config.username, password: config.password },
    });
  });

  it.each([
    "sip:+15551234567@conduit.dapp.signalwire.com",
    "https://conduit.dapp.signalwire.com",
    "conduit.dapp.signalwire.com:5061",
    "conduit.dapp.signalwire.com;transport=tls",
  ])("rejects a URI or port in the hostname field: %s", (sipAddress) => {
    expect(() => buildElevenLabsSipTrunkRequest({ ...config, sipAddress })).toThrow(/hostname/i);
  });

  it("rejects the registered-device domain that returned SIP 404 in Conduit", () => {
    expect(() => buildElevenLabsSipTrunkRequest({ ...config, sipAddress: "example.sip.signalwire.com" }))
      .toThrow(/Domain Application/i);
  });

  it.each(["username", "password"] as const)("requires a nonempty %s", (field) => {
    expect(() => buildElevenLabsSipTrunkRequest({ ...config, [field]: "" })).toThrow(/credentials/i);
  });
});
