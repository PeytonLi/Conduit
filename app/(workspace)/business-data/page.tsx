import { requireMembership } from "@/lib/auth";
import { getBusinessData } from "@/lib/db/queries/business-data";
import { formatDateTime, formatQuantity } from "@/lib/db/queries/format";

export default async function BusinessDataPage() {
  const membership = await requireMembership();
  const data = await getBusinessData(membership);
  return (
    <main>
      <h1>Business data</h1>
      <p>Current source datasets and the inventory, demand, and receipts used in case assessments.</p>
      <section aria-labelledby="datasets-heading">
        <h2 id="datasets-heading">Active datasets</h2>
        {data.datasets.length ? (
          <ul>{data.datasets.map((dataset) => (
            <li key={dataset.id}>
              <strong>{dataset.label} · {dataset.source_type}</strong>
              {" — Source data as of "}
              {formatDateTime(dataset.source_as_of, "UTC") ?? "Unknown"}
              {dataset.status !== "active" && ` · ${dataset.status}`}
            </li>
          ))}</ul>
        ) : <p>No active datasets. Import a business data file to get started.</p>}
      </section>
      <p role="status">Import preview and commit are not available in this build yet.</p>
      <section aria-labelledby="inventory-heading">
        <h2 id="inventory-heading">Inventory</h2>
        <div style={{ overflowX: "auto" }}><table>
          <caption>Inventory snapshots</caption>
          <thead><tr><th scope="col">Item</th><th scope="col">Location</th><th scope="col">Physical</th><th scope="col">Unusable</th><th scope="col">Allocated</th><th scope="col">Usable</th><th scope="col">Source as of</th></tr></thead>
          <tbody>{data.inventory.map((row) => <tr key={row.id}><td>{row.sku} · {row.description}</td><td>{row.location}</td><td>{formatQuantity(row.physical_qty, row.unit)}</td><td>{formatQuantity(row.unusable_qty, row.unit)}</td><td>{formatQuantity(row.outside_allocations_qty, row.unit)}</td><td>{formatQuantity(row.usable_qty, row.unit)}</td><td>{formatDateTime(row.source_as_of, "UTC")}</td></tr>)}</tbody>
        </table></div>
      </section>
      <section aria-labelledby="demand-heading">
        <h2 id="demand-heading">Demand</h2>
        <div style={{ overflowX: "auto" }}><table>
          <caption>Open demand requirements</caption>
          <thead><tr><th scope="col">Item</th><th scope="col">Location</th><th scope="col">Remaining</th><th scope="col">Required</th><th scope="col">Certainty</th><th scope="col">Status</th></tr></thead>
          <tbody>{data.demand.map((row) => <tr key={row.id}><td>{row.sku}</td><td>{row.location}</td><td>{formatQuantity(row.remaining_qty, row.unit)}</td><td>{formatDateTime(row.required_at, "UTC")}</td><td>{row.certainty || "Unknown"}</td><td>{row.status}</td></tr>)}</tbody>
        </table></div>
      </section>
      <section aria-labelledby="po-heading">
        <h2 id="po-heading">Purchase orders and receipts</h2>
        {data.purchase_orders.length ? data.purchase_orders.map((order) => (
          <article key={order.id}>
            <h3>{order.external_id} · {order.supplier} · {order.status}</h3>
            <ul>{order.lines.map((line) => <li key={line.id}>
              {line.sku} · ordered {formatQuantity(line.ordered_qty, line.unit)} · received {formatQuantity(line.received_qty, line.unit)} · original due {formatDateTime(line.original_due_at, "UTC") ?? "Unknown"}
              {line.receipt_schedules.map((receipt, index) => <span key={index}> · Expected {formatQuantity(receipt.quantity_remaining, line.unit)} by {formatDateTime(receipt.earliest_at, "UTC") ?? "Unknown"}</span>)}
            </li>)}</ul>
          </article>
        )) : <p>No purchase order data is available.</p>}
      </section>
    </main>
  );
}
