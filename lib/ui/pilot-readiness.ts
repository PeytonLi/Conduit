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
  envCapabilities: CapabilityStatus,
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
  const mailboxEnvReady = envCapabilities.gmail.ready || envCapabilities.outlook.ready;

  return {
    analysis: envCapabilities.deepseek.ready,
    email: mailboxEnvReady && mailboxConnected,
    voice: envCapabilities.voice.ready,
    businessWriteBack: erpConnected,
  };
}
