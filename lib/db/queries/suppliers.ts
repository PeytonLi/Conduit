import { QueryError, type QueryContext, queryClient } from "./client";

// PostgREST table names are dynamic in this projection layer.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

function fail(error: { message: string } | null): void {
  if (error) {
    throw new QueryError("query_failed", 503, "Supplier data is temporarily unavailable");
  }
}

export interface SupplierSummary {
  id: string;
  name: string;
  purchasing_status: string;
  row_version: number;
  approval_at: string | null;
  contacts: {
    id: string;
    channel: string;
    address: string;
    display_name: string | null;
    permitted_channels: string[];
    outreach_approved: boolean;
    identity_verified: boolean;
    row_version: number;
  }[];
  items: { sku: string; last_verified_at: string | null }[];
}

export async function listSuppliers(context: QueryContext): Promise<SupplierSummary[]> {
  const client = await queryClient(context);
  const suppliersResult = await client.from("suppliers").select("*").eq("org_id", context.orgId)
    .order("name", { ascending: true });
  fail(suppliersResult.error);
  const supplierRows: Row[] = suppliersResult.data ?? [];
  if (supplierRows.length === 0) return [];
  const supplierIds = supplierRows.map((row) => row.id);
  const [contactsResult, supplierItemsResult] = await Promise.all([
    client.from("supplier_contacts").select("*")
      .eq("org_id", context.orgId).in("supplier_id", supplierIds),
    client.from("supplier_items").select("*")
      .eq("org_id", context.orgId).in("supplier_id", supplierIds),
  ]);
  fail(contactsResult.error);
  fail(supplierItemsResult.error);
  const contactRows: Row[] = contactsResult.data ?? [];
  const supplierItems: Row[] = supplierItemsResult.data ?? [];
  const itemIds = [...new Set(supplierItems.map((row) => row.item_id))];
  const itemsResult = itemIds.length
    ? await client.from("items").select("id,sku").eq("org_id", context.orgId).in("id", itemIds)
    : { data: [], error: null };
  fail(itemsResult.error);
  const itemMap = new Map((itemsResult.data ?? []).map((row: Row) => [row.id, row]));
  const evidenceIds = [...new Set(contactRows.map((row) => row.identity_evidence_id).filter(Boolean))];
  const evidenceResult = evidenceIds.length
    ? await client.from("evidence").select("id,verified_at")
        .eq("org_id", context.orgId).in("id", evidenceIds)
    : { data: [], error: null };
  fail(evidenceResult.error);
  const evidenceMap = new Map(
    (evidenceResult.data ?? []).map((row: Row) => [row.id, row]),
  );

  return supplierRows.map((supplier) => ({
    id: supplier.id,
    name: supplier.name,
    purchasing_status: supplier.purchasing_status,
    row_version: supplier.row_version,
    approval_at: supplier.approval_at,
    contacts: contactRows
      .filter((contact) => contact.supplier_id === supplier.id)
      .map((contact) => ({
        id: contact.id,
        channel: contact.channel,
        address: contact.normalized_address,
        display_name: contact.display_name,
        permitted_channels: contact.permitted_channels,
        outreach_approved: Boolean(contact.outreach_approved_at),
        identity_verified: Boolean(
          contact.identity_evidence_id && evidenceMap.get(contact.identity_evidence_id)?.verified_at,
        ),
        row_version: contact.row_version,
      })),
    items: supplierItems
      .filter((entry) => entry.supplier_id === supplier.id)
      .map((entry) => ({
        sku: itemMap.get(entry.item_id)?.sku ?? "",
        last_verified_at: entry.last_verified_at,
      })),
  }));
}
