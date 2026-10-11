export function getStartedCompletion(
  connections: readonly { provider: string; status: string }[],
  business: { datasets: readonly unknown[] },
  suppliers: readonly { contacts: readonly { identity_verified: boolean }[] }[],
) {
  return {
    gmail: connections.some((connection) =>
      connection.provider === "gmail" &&
      (connection.status === "healthy" || connection.status === "degraded"),
    ),
    businessData: business.datasets.length > 0,
    supplierContacts: suppliers.some((supplier) =>
      supplier.contacts.some((contact) => contact.identity_verified),
    ),
  };
}
