import { requireMembership } from "@/lib/auth";
import { ImportPreview } from "@/components/ImportPreview";
import { getBusinessData } from "@/lib/db/queries/business-data";
import { formatDateTime, formatQuantity } from "@/lib/db/queries/format";
import { humanLabel } from "@/lib/db/queries/labels";
import { DataTable } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { getOrganization } from "@/lib/db/queries/organization";
import styles from "./business-data.module.css";

export default async function BusinessDataPage() {
  const membership = await requireMembership();
  const [data, organization] = await Promise.all([
    getBusinessData(membership),
    getOrganization(membership),
  ]);
  return (
    <main className={styles.page}>
      <PageHeader description="Manage the source data behind inventory, demand, and recovery decisions." title="Business data" />
      <section aria-labelledby="datasets-heading">
        <h2 id="datasets-heading">Active datasets</h2>
        {data.datasets.length ? (
          <ul className={styles.datasetGrid}>{data.datasets.map((dataset) => (
            <li key={dataset.id}>
              <Card className={styles.datasetCard}>
                <strong>{dataset.label} · {humanLabel("evidenceSourceType", dataset.source_type)}</strong>
                {" — Source data as of "}
                {formatDateTime(dataset.source_as_of, organization.timezone) ?? "Not provided"}
                {dataset.status !== "active" && ` · ${humanLabel("datasetStatus", dataset.status)}`}
              </Card>
            </li>
          ))}</ul>
        ) : <EmptyState icon="database" message="Import a business data file to get started." />}
      </section>
      <ImportPreview role={membership.role} />
      <section aria-labelledby="inventory-heading">
        <h2 id="inventory-heading">Inventory</h2>
        {data.inventory.length ? <DataTable caption="Inventory snapshots" className={styles.table}>
          <thead><tr><th scope="col">Item</th><th scope="col">Location</th><th scope="col">Physical</th><th scope="col">Unusable</th><th scope="col">Allocated</th><th scope="col">Usable</th><th scope="col">Source as of</th></tr></thead>
          <tbody>{data.inventory.map((row) => <tr key={row.id}><td>{row.sku} · {row.description}</td><td>{row.location}</td><td>{formatQuantity(row.physical_qty, row.unit)}</td><td>{formatQuantity(row.unusable_qty, row.unit)}</td><td>{formatQuantity(row.outside_allocations_qty, row.unit)}</td><td>{formatQuantity(row.usable_qty, row.unit)}</td><td>{formatDateTime(row.source_as_of, organization.timezone) ?? "Not provided"}</td></tr>)}</tbody>
        </DataTable> : <EmptyState icon="package" message="No inventory snapshots are available yet." />}
      </section>
      <section aria-labelledby="demand-heading">
        <h2 id="demand-heading">Demand</h2>
        {data.demand.length ? <DataTable caption="Open demand requirements" className={styles.table}>
          <thead><tr><th scope="col">Item</th><th scope="col">Location</th><th scope="col">Remaining</th><th scope="col">Required</th><th scope="col">Certainty</th><th scope="col">Status</th></tr></thead>
          <tbody>{data.demand.map((row) => <tr key={row.id}><td>{row.sku}</td><td>{row.location}</td><td>{formatQuantity(row.remaining_qty, row.unit)}</td><td>{formatDateTime(row.required_at, organization.timezone) ?? "Not provided"}</td><td>{humanLabel("demandCertainty", row.certainty)}</td><td>{humanLabel("demandStatus", row.status)}</td></tr>)}</tbody>
        </DataTable> : <EmptyState icon="activity" message="No open demand requirements are available yet." />}
      </section>
      <section aria-labelledby="po-heading">
        <h2 id="po-heading">Purchase orders and receipts</h2>
        {data.purchase_orders.length ? data.purchase_orders.map((order) => (
          <Card className={styles.orderCard} key={order.id}>
            <h3>{order.external_id} · {order.supplier} · {humanLabel("purchaseOrderStatus", order.status)}</h3>
            <ul>{order.lines.map((line) => <li key={line.id}>
              {line.sku} · ordered {formatQuantity(line.ordered_qty, line.unit)} · received {formatQuantity(line.received_qty, line.unit)}
              {line.original_due_at && ` · Original due ${formatDateTime(line.original_due_at, organization.timezone) ?? "Not available"}`}
              {line.receipt_schedules.map((receipt, index) => <span key={index}> · Expected {formatQuantity(receipt.quantity_remaining, line.unit)} by {formatDateTime(receipt.earliest_at, organization.timezone) ?? "Not confirmed yet"}</span>)}
            </li>)}</ul>
          </Card>
        )) : <EmptyState icon="file" message="No purchase order or receipt data is available yet." />}
      </section>
    </main>
  );
}
