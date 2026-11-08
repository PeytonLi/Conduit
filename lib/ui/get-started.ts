import { isMailboxProvider } from "@/lib/integrations/mailbox/types";

export function getStartedCompletion(
  connections: readonly { provider: string; status: string }[],
  business: { datasets: readonly unknown[] },
  suppliers: readonly { contacts: readonly { identity_verified: boolean }[] }[],
) {
  return {
    // True once any mailbox (Gmail or Outlook) is connected. The key keeps its
    // original name so existing callers need no change.
    gmail: connections.some((connection) =>
      isMailboxProvider(connection.provider) &&
      (connection.status === "healthy" || connection.status === "degraded"),
    ),
    businessData: business.datasets.length > 0,
    supplierContacts: suppliers.some((supplier) =>
      supplier.contacts.some((contact) => contact.identity_verified),
    ),
  };
}
