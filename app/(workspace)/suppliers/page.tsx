import { requireMembership } from "@/lib/auth";
import { listSuppliers } from "@/lib/db/queries/suppliers";
import { SupplierApprovalControls } from "@/components/SupplierApprovalControls";

export default async function SuppliersPage() {
  const membership = await requireMembership();
  const suppliers = await listSuppliers(membership);
  return (
    <main>
      <h1>Suppliers</h1>
      <p>Supplier purchasing status, approved contacts, and items.</p>
      {suppliers.length ? suppliers.map((supplier) => (
        <article key={supplier.id}>
          <h2>{supplier.name}</h2>
          <p>Purchasing: {supplier.purchasing_status} · Approval updated: {supplier.approval_at ?? "Unknown"}</p>
          <h3>Contacts</h3>
          {supplier.contacts.length ? <ul>{supplier.contacts.map((contact) => (
            <li key={contact.id}>
              {contact.display_name ?? contact.address} · {contact.channel} · {contact.identity_verified ? "Identity verified" : "Identity not verified"} · {contact.outreach_approved ? "Outreach approved" : "Outreach not approved"}
            </li>
          ))}</ul> : <p>No supplier contacts.</p>}
          <h3>Items</h3>
          <p>{supplier.items.length ? supplier.items.map((item) => `${item.sku} (verified ${item.last_verified_at ?? "Unknown"})`).join(", ") : "No linked items."}</p>
          {membership.role === "owner" ? <SupplierApprovalControls supplier={supplier} /> : <p>Read-only: only an owner can change supplier approvals.</p>}
        </article>
      )) : <p>No suppliers are available.</p>}
    </main>
  );
}
