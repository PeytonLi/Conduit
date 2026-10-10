import type { ElevenLabs } from "@elevenlabs/elevenlabs-js";

/**
 * SignalWire is only the SIP carrier: ElevenLabs places the call through an imported SIP trunk.
 * Use a PSTN termination Domain Application, not a registered-device SIP Credential domain.
 * Values come from the SignalWire dashboard/support; see docs/voice-setup.md.
 */
export interface SignalWireTrunkConfig {
  /** E.164 SignalWire number used as caller ID. */
  phoneNumber: string;
  /** Bare termination hostname, without a SIP URI, port, or transport suffix. */
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
  if (!config.sipAddress || /[\s/:@;?#]/.test(config.sipAddress)) {
    throw new Error("SIP address must be a bare hostname, without a URI, port, or transport suffix");
  }
  if (/\.sip\.(signalwire\.com|swire\.io)$/i.test(config.sipAddress)) {
    throw new Error("SignalWire SIP Credential domains require device registration; use a PSTN termination Domain Application (.dapp.signalwire.com) with its own authentication");
  }
  if (!config.username.trim() || !config.password) throw new Error("SIP digest credentials are required");
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
