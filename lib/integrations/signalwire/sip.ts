import type { ElevenLabs } from "@elevenlabs/elevenlabs-js";

/**
 * SignalWire is only the SIP carrier: ElevenLabs places the call through an imported SIP trunk.
 * Values come from the SignalWire dashboard (SIP endpoint/domain + credentials); see docs/voice-setup.md.
 */
export interface SignalWireTrunkConfig {
  /** E.164 SignalWire number used as caller ID. */
  phoneNumber: string;
  /** SIP address/host to send outbound INVITEs to, exactly as shown in SignalWire. */
  sipAddress: string;
  username: string;
  password: string;
  transport?: "tls" | "tcp" | "udp" | "auto";
  label?: string;
}

const E164 = /^\+[1-9]\d{6,14}$/;

export function buildElevenLabsSipTrunkRequest(
  config: SignalWireTrunkConfig,
): ElevenLabs.CreateSipTrunkPhoneNumberRequest & { provider: "sip_trunk" } {
  if (!E164.test(config.phoneNumber)) throw new Error("SignalWire phone number must be E.164");
  if (!config.sipAddress || /\s/.test(config.sipAddress)) throw new Error("SIP address is required");
  return {
    provider: "sip_trunk",
    phoneNumber: config.phoneNumber,
    label: config.label ?? "Conduit SignalWire trunk",
    outboundTrunkConfig: {
      address: config.sipAddress,
      transport: config.transport ?? "tls",
      credentials: { username: config.username, password: config.password },
    },
  };
}
