import { QueryError, type QueryContext, queryClient } from "./client";

// PostgREST projections combine several dynamic tables.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export interface DatasetView {
  id: string;
  source_type: string;
  source_as_of: string;
  imported_at: string;
  status: string;
  label: "Replay" | "Imported" | "Live";
  row_version: number;
}

export interface InventoryView {
  id: string;
  dataset_id: string;
  sku: string;
  description: string;
  location: string;
  physical_qty: number;
  unusable_qty: number;
  outside_allocations_qty: number;
  usable_qty: number;
  unit: string;
  source_as_of: string;
}

export interface DemandView {
  id: string;
  dataset_id: string;
  external_id: string | null;
  sku: string;
  location: string;
  remaining_qty: number;
  unit: string;
  required_at: string;
  certainty: string;
  included_reserved_qty: number;
  status: string;
  source_as_of: string;
}

export interface PurchaseOrderView {
  id: string;
  dataset_id: string;
  external_id: string;
  supplier: string;
  status: string;
  currency: string;
  lines: {
    id: string;
    external_line_id: string | null;
    sku: string;
    description: string;
    location: string;
    ordered_qty: number;
    received_qty: number;
    cancelled_qty: number;
    unit: string;
    original_due_at: string | null;
    receipt_schedules: {
      quantity_remaining: number;
      earliest_at: string | null;
      latest_at: string | null;
      promise_state: string;
      source_as_of: string | null;
    }[];
  }[];
}

export interface BusinessDataResult {
  datasets: DatasetView[];
  inventory: InventoryView[];
  demand: DemandView[];
  purchase_orders: PurchaseOrderView[];
}

function fail(error: { message: string } | null): void {
  if (error) {
    throw new QueryError("query_failed", 503, "Business data is temporarily unavailable");
  }
}

function sourceLabel(sourceType: string): DatasetView["label"] {
  if (sourceType === "fixture") return "Replay";
  if (sourceType === "csv") return "Imported";
  return "Live";
}

export async function getBusinessData(context: QueryContext): Promise<BusinessDataResult> {
  const client = await queryClient(context);
  const datasetsResult = await client.from("datasets").select("*")
    .eq("org_id", context.orgId)
    .eq("status", "active")
    .order("source_as_of", { ascending: false });
  fail(datasetsResult.error);
  const datasets: Row[] = datasetsResult.data ?? [];
  const datasetIds = datasets.map((dataset) => dataset.id);
  if (datasetIds.length === 0) {
    return { datasets: [], inventory: [], demand: [], purchase_orders: [] };
  }

  const [inventoryResult, demandResult, orderResult] = await Promise.all([
    client.from("inventory_snapshots").select("*")
      .eq("org_id", context.orgId).in("dataset_id", datasetIds)
      .order("source_as_of", { ascending: false }),
    client.from("demand_requirements").select("*")
      .eq("org_id", context.orgId).in("dataset_id", datasetIds)
      .order("required_at", { ascending: true }),
    client.from("purchase_orders").select("*")
      .eq("org_id", context.orgId).in("dataset_id", datasetIds)
      .order("external_id", { ascending: true }),
  ]);
  fail(inventoryResult.error);
  fail(demandResult.error);
  fail(orderResult.error);
  const inventoryRows: Row[] = inventoryResult.data ?? [];
  const demandRows: Row[] = demandResult.data ?? [];
  const orderRows: Row[] = orderResult.data ?? [];
  const supplierIds = [...new Set(orderRows.map((row) => row.supplier_id))];
  const orderIds = orderRows.map((row) => row.id);
  const linesResult = orderIds.length
    ? await client.from("purchase_order_lines").select("*")
        .eq("org_id", context.orgId).in("purchase_order_id", orderIds)
    : { data: [], error: null };
  fail(linesResult.error);
  const lineRows: Row[] = linesResult.data ?? [];
  const itemIds = [...new Set([
    ...inventoryRows.map((row) => row.item_id),
    ...demandRows.map((row) => row.item_id),
    ...lineRows.map((row) => row.item_id),
  ])];
  const locationIds = [...new Set([
    ...inventoryRows.map((row) => row.location_id),
    ...demandRows.map((row) => row.location_id),
    ...lineRows.map((row) => row.destination_location_id),
  ])];
  const [itemsResult, locationsResult, suppliersResult] = await Promise.all([
    itemIds.length
      ? client.from("items").select("id,sku,description,base_unit")
          .eq("org_id", context.orgId).in("id", itemIds)
      : Promise.resolve({ data: [], error: null }),
    locationIds.length
      ? client.from("locations").select("id,name")
          .eq("org_id", context.orgId).in("id", locationIds)
      : Promise.resolve({ data: [], error: null }),
    supplierIds.length
      ? client.from("suppliers").select("id,name")
          .eq("org_id", context.orgId).in("id", supplierIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  fail(itemsResult.error);
  fail(locationsResult.error);
  fail(suppliersResult.error);
  const itemRows: Row[] = itemsResult.data ?? [];
  const locationRows: Row[] = locationsResult.data ?? [];
  const supplierRows: Row[] = suppliersResult.data ?? [];
  const lineIds = lineRows.map((row) => row.id);
  const receiptsResult = lineIds.length
    ? await client.from("receipt_schedules").select("*")
        .eq("org_id", context.orgId).in("po_line_id", lineIds)
        .order("earliest_at", { ascending: true })
    : { data: [], error: null };
  fail(receiptsResult.error);
  const receiptRows: Row[] = receiptsResult.data ?? [];
  const itemById = new Map(itemRows.map((item) => [item.id, item]));
  const locationById = new Map(locationRows.map((location) => [location.id, location]));
  const supplierById = new Map(supplierRows.map((supplier) => [supplier.id, supplier]));
  const receiptsByLine = new Map<string, Row[]>();
  for (const receipt of receiptRows) {
    const rows = receiptsByLine.get(receipt.po_line_id) ?? [];
    rows.push(receipt);
    receiptsByLine.set(receipt.po_line_id, rows);
  }
  const ordersById = new Map<string, Row[]>();
  for (const line of lineRows) {
    const rows = ordersById.get(line.purchase_order_id) ?? [];
    rows.push(line);
    ordersById.set(line.purchase_order_id, rows);
  }

  return {
    datasets: datasets.map((dataset) => ({
      id: dataset.id,
      source_type: dataset.source_type,
      source_as_of: dataset.source_as_of,
      imported_at: dataset.imported_at,
      status: dataset.status,
      label: sourceLabel(dataset.source_type),
      row_version: dataset.row_version,
    })),
    inventory: inventoryRows.map((row) => {
      const item = itemById.get(row.item_id);
      return {
        id: row.id,
        dataset_id: row.dataset_id,
        sku: item?.sku ?? "Unknown",
        description: item?.description ?? "Unknown",
        location: locationById.get(row.location_id)?.name ?? "Unknown",
        physical_qty: row.physical_qty,
        unusable_qty: row.unusable_qty,
        outside_allocations_qty: row.outside_allocations_qty,
        usable_qty: row.physical_qty - row.unusable_qty - row.outside_allocations_qty,
        unit: item?.base_unit ?? "unit",
        source_as_of: row.source_as_of,
      };
    }),
    demand: demandRows.map((row) => {
      const item = itemById.get(row.item_id);
      return {
        id: row.id,
        dataset_id: row.dataset_id,
        external_id: row.external_id,
        sku: item?.sku ?? "Unknown",
        location: locationById.get(row.location_id)?.name ?? "Unknown",
        remaining_qty: row.remaining_qty,
        unit: item?.base_unit ?? "unit",
        required_at: row.required_at,
        certainty: row.certainty,
        included_reserved_qty: row.included_reserved_qty,
        status: row.status,
        source_as_of: row.source_as_of,
      };
    }),
    purchase_orders: orderRows.map((order) => ({
      id: order.id,
      dataset_id: order.dataset_id,
      external_id: order.external_id,
      supplier: supplierById.get(order.supplier_id)?.name ?? "Unknown",
      status: order.status,
      currency: order.currency,
      lines: (ordersById.get(order.id) ?? []).map((line) => {
        const item = itemById.get(line.item_id);
        return {
          id: line.id,
          external_line_id: line.external_line_id,
          sku: item?.sku ?? "Unknown",
          description: item?.description ?? "Unknown",
          location: locationById.get(line.destination_location_id)?.name ?? "Unknown",
          ordered_qty: line.ordered_qty,
          received_qty: line.received_qty,
          cancelled_qty: line.cancelled_qty,
          unit: item?.base_unit ?? "unit",
          original_due_at: line.original_due_at,
          receipt_schedules: (receiptsByLine.get(line.id) ?? []).map((receipt) => ({
            quantity_remaining: receipt.quantity_remaining,
            earliest_at: receipt.earliest_at,
            latest_at: receipt.latest_at,
            promise_state: receipt.promise_state,
            source_as_of: receipt.source_as_of,
          })),
        };
      }),
    })),
  };
}
