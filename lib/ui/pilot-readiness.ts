import type { CapabilityStatus } from "@/lib/env";
import { isErpProvider } from "@/lib/integrations/business/live/registry";
import { isActiveMailboxStatus, isMailboxProvider } from "@/lib/integrations/mailbox/types";

export type PilotReadiness = {
  analysis: boolean;
  email: boolean;
  voice: boolean;
  businessWriteBack: boolean;
};

export function getPilotReadiness(
  connections: readonly { provider: string; status: string }[],
  envCapabilities: Partial<CapabilityStatus>,
  appEnvironment: "replay" | "sandbox" | "live",
): PilotReadiness {
  if (appEnvironment === "replay") {
    return {
      analysis: true,
      email: true,
      voice: true,
      businessWriteBack: true,
    };
  }

  const mailboxConnected = connections.some(
    (connection) =>
      isMailboxProvider(connection.provider) && isActiveMailboxStatus(connection.status),
  );
  const erpConnected = connections.some(
    (connection) =>
      isErpProvider(connection.provider) && isActiveMailboxStatus(connection.status),
  );
  // Capability maps from callers/tests may omit providers; treat missing as not ready.
  const mailboxEnvReady = Boolean(
    envCapabilities.gmail?.ready || envCapabilities.outlook?.ready,
  );

  return {
    analysis: Boolean(envCapabilities.deepseek?.ready),
    email: mailboxEnvReady && mailboxConnected,
    voice: Boolean(envCapabilities.voice?.ready),
    businessWriteBack: erpConnected,
  };
}
