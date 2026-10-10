import { requireMembership } from "@/lib/auth";
import { humanLabel } from "@/lib/db/queries/labels";
import { formatDateTime } from "@/lib/db/queries/format";
import { getOrganization } from "@/lib/db/queries/organization";
import { listSuppliers } from "@/lib/db/queries/suppliers";
import { SupplierApprovalControls } from "@/components/SupplierApprovalControls";
import { Card } from "@/components/ui/Card";
import { Disclosure } from "@/components/ui/Disclosure";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusBadge } from "@/components/StatusBadge";
import styles from "./suppliers.module.css";

export default async function SuppliersPage() {
  const membership = await requireMembership();
  const [suppliers, organization] = await Promise.all([
    listSuppliers(membership),
    getOrganization(membership),
  ]);
  return (
    <main className={styles.page}>
      <PageHeader description="Review supplier status, approved contacts, and linked items." title="Suppliers" />
      {suppliers.length ? suppliers.map((supplier) => (
        <Card className={styles.card} key={supplier.id}>
          <header className={styles.cardHeader}>
            <h2>{supplier.name}</h2>
            <StatusBadge>{humanLabel("supplierStatus", supplier.purchasing_status)}</StatusBadge>
          </header>
          {supplier.approval_at && <p className={styles.updated}>Approval updated {formatDateTime(supplier.approval_at, organization.timezone)}</p>}
          <section aria-label={`${supplier.name} contacts`}>
            <h3>Contacts</h3>
            {supplier.contacts.length ? <ul className={styles.list}>{supplier.contacts.map((contact) => (
              <li key={contact.id}>
                <strong>{contact.display_name ?? contact.address}</strong>
                <span>{humanLabel("contactChannel", contact.channel)}</span>
                <span>{contact.identity_verified ? "Identity verified" : "Identity not verified"}</span>
                <StatusBadge tone={contact.outreach_approved ? "success" : "warning"}>
                  {contact.outreach_approved ? "Outreach approved" : "Outreach not approved"}
                </StatusBadge>
              </li>
            ))}</ul> : <p>No supplier contacts.</p>}
          </section>
          <section aria-label={`${supplier.name} linked items`}>
            <h3>Items</h3>
            {supplier.items.length ? <ul className={styles.list}>{supplier.items.map((item, index) => (
              <li key={`${item.sku}-${index}`}>
                <strong>{item.sku}</strong>
                <span>Last verified {formatDateTime(item.last_verified_at, organization.timezone) ?? "Unknown"}</span>
              </li>
            ))}</ul> : <p>No linked items.</p>}
          </section>
          <Disclosure summary="Approval controls">
            {membership.role === "owner"
              ? <SupplierApprovalControls supplier={supplier} />
              : <p>Only an owner can change supplier approvals.</p>}
          </Disclosure>
        </Card>
      )) : <EmptyState message="No suppliers are available." />}
    </main>
  );
}
