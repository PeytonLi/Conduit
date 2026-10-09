import { createHash } from "node:crypto";
import { parseCsv, CsvParseError, type ParsedCsv } from "./import-csv";
import { DomainValidationError } from "./errors";
import { currencyMinorDigits, parseMinorUnits } from "./money";
import { parseQuantity } from "./quantity";
import { compareText, isValidTimeZone, parseInstant, toIso } from "./time";

const requiredColumns = {
  "suppliers.csv": [
    "supplier_id", "name", "purchasing_status", "contact_name", "email", "phone",
    "contact_timezone", "outreach_approved",
  ],
  "items.csv": [
    "item_id", "sku", "description", "base_unit", "length_mm", "width_mm", "height_mm",
    "material_grade",
  ],
  "purchase_orders.csv": ["po_id", "supplier_id", "currency", "status"],
  "purchase_order_lines.csv": [
    "po_id", "line_id", "item_id", "location_id", "ordered_qty", "received_qty",
    "cancelled_qty", "unit_price_minor", "original_due_at",
  ],
  "receipt_schedules.csv": [
    "receipt_id", "po_id", "line_id", "quantity_remaining", "earliest_at", "latest_at",
    "promise_state", "source_reference",
  ],
  "inventory.csv": [
    "item_id", "location_id", "physical_qty", "unusable_qty", "outside_allocations_qty",
    "source_as_of",
  ],
  "demand.csv": [
    "demand_id", "item_id", "location_id", "remaining_qty", "required_at", "certainty",
    "included_reserved_qty", "source_as_of",
  ],
} as const;

type ImportFile = keyof typeof requiredColumns;
type Metadata = { schema_version: 1; source_as_of: string; timezone: string; currency: string };
type KnownLocation = { id: string; externalId: string; timezone: string };

export type ImportIssue = {
  file: string | null;
  row: number | null;
  field: string | null;
  code: string;
  message: string;
};

export type NormalizedImport = {
  suppliers: {
    external_id: string;
    name: string;
    purchasing_status: string;
    contacts: {
      channel: "email" | "phone";
      normalized_address: string;
      display_name: string | null;
      timezone: string | null;
      outreach_approved: boolean;
    }[];
  }[];
  items: {
    external_id: string;
    sku: string;
    description: string;
    base_unit: string;
    specification: {
      length_mm: number;
      width_mm: number;
      height_mm: number;
      material_grade: string;
    };
  }[];
  purchase_orders: {
    external_id: string;
    supplier_external_id: string;
    currency: string;
    status: string;
  }[];
  purchase_order_lines: {
    po_external_id: string;
    external_line_id: string;
    item_external_id: string;
    location_external_id: string;
    ordered_qty: number;
    received_qty: number;
    cancelled_qty: number;
    unit_price_minor: string;
    original_due_at: string | null;
  }[];
  receipt_schedules: {
    external_id: string;
    po_external_id: string;
    external_line_id: string;
    quantity_remaining: number;
    earliest_at: string | null;
    latest_at: string | null;
    promise_state: string;
    source_reference: string;
    locator: string;
    row_hash: string;
  }[];
  inventory: {
    item_external_id: string;
    location_external_id: string;
    physical_qty: number;
    unusable_qty: number;
    outside_allocations_qty: number;
    source_as_of: string;
  }[];
  demand: {
    external_id: string;
    item_external_id: string;
    location_external_id: string;
    remaining_qty: number;
    required_at: string;
    certainty: string;
    included_reserved_qty: number;
    source_as_of: string;
  }[];
  metadata: {
    schema_version: 1;
    source_as_of: string;
    timezone: string;
    currency: string;
  };
};

type ValidateImportArgs = {
  files: Record<string, string>;
  metadata: Metadata;
  orgCurrency: string;
  knownLocations: KnownLocation[];
  now: string;
};

type RawRow = { file: ImportFile; line: number; values: string[]; fields: Record<string, string> };

function issue(
  file: string | null,
  row: number | null,
  field: string | null,
  code: string,
  message = code,
): ImportIssue {
  return { file, row, field, code, message };
}

function normalizeTimestamp(value: string): string | null {
  const milliseconds = parseInstant(value);
  return milliseconds === null ? null : toIso(milliseconds);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseRows(
  file: ImportFile,
  parsed: ParsedCsv,
  errors: ImportIssue[],
  warnings: ImportIssue[],
): RawRow[] {
  for (const column of requiredColumns[file]) {
    if (!parsed.header.includes(column)) {
      errors.push(issue(file, null, column, "missing_column", `Required column ${column} is missing.`));
    }
  }
  const required = new Set<string>(requiredColumns[file]);
  for (const column of parsed.header) {
    if (!required.has(column)) warnings.push(issue(file, null, column, "extra_column", `Extra column ${column} is ignored.`));
  }
  if (new Set(parsed.header).size !== parsed.header.length) {
    errors.push(issue(file, null, null, "duplicate_column", "Column names must be unique."));
  }
  for (const row of parsed.rows) {
    if (row.values.length !== parsed.header.length) {
      errors.push(issue(file, row.line, null, "column_count_mismatch", "Row field count does not match the header."));
    }
  }
  return parsed.rows.map((row) => ({ file, line: row.line, values: row.values, fields: row.fields }));
}

function quantityField(row: RawRow, field: string, errors: ImportIssue[]): number | null {
  const value = row.fields[field] ?? "";
  const result = parseQuantity(value);
  if (!result.ok) {
    errors.push(issue(row.file, row.line, field, result.code, `${field} must be a supported whole quantity.`));
    return null;
  }
  return result.value;
}

function timestampField(
  row: RawRow,
  field: string,
  errors: ImportIssue[],
  optional = false,
): string | null {
  const value = row.fields[field] ?? "";
  if (value === "" && optional) return null;
  const normalized = normalizeTimestamp(value);
  if (normalized === null) {
    errors.push(issue(row.file, row.line, field, value === "" ? "empty" : "invalid_timestamp", `${field} must be an ISO 8601 timestamp with an offset.`));
  }
  return normalized;
}

function addUnique(
  map: Map<string, RawRow>,
  key: string,
  row: RawRow,
  field: string,
  errors: ImportIssue[],
): void {
  if (key === "") {
    errors.push(issue(row.file, row.line, field, "empty", `${field} is required.`));
    return;
  }
  if (map.has(key)) errors.push(issue(row.file, row.line, field, "duplicate_id", `${field} must be unique.`));
  else map.set(key, row);
}

function inFutureChecks(
  row: RawRow,
  field: string,
  sourceAsOf: string,
  nowMs: number | null,
  metadataMs: number | null,
  errors: ImportIssue[],
  warnings: ImportIssue[],
): void {
  const value = parseInstant(sourceAsOf);
  if (value === null) return;
  if ((nowMs !== null && value > nowMs) || (metadataMs !== null && value > metadataMs)) {
    errors.push(issue(row.file, row.line, field, "source_as_of_in_future", "Row source_as_of is later than the import clock or metadata snapshot."));
  } else if (metadataMs !== null && metadataMs - value > 15 * 60_000) {
    warnings.push(issue(row.file, row.line, field, "stale_source", "Row source_as_of is more than 15 minutes older than the snapshot."));
  }
}

export function validateImport(args: ValidateImportArgs): {
  ok: boolean;
  errors: ImportIssue[];
  warnings: ImportIssue[];
  counts: Record<string, number>;
  payload: NormalizedImport | null;
  contentHash: string;
} {
  const errors: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  const counts: Record<string, number> = {};
  const rawRows = new Map<ImportFile, RawRow[]>();
  const files = args.files;

  for (const file of Object.keys(requiredColumns) as ImportFile[]) {
    counts[file] = 0;
    const text = files[file];
    if (text === undefined) {
      errors.push(issue(file, null, null, "missing_file", `Required file ${file} is missing.`));
      continue;
    }
    try {
      const parsed = parseCsv(text);
      const rows = parseRows(file, parsed, errors, warnings);
      rawRows.set(file, rows);
      counts[file] = rows.length;
    } catch (error) {
      const line = error instanceof CsvParseError ? error.line : null;
      errors.push(issue(file, line, null, error instanceof CsvParseError ? error.message : "invalid_csv"));
    }
  }
  for (const file of Object.keys(files)) {
    if (!(file in requiredColumns)) warnings.push(issue(file, null, null, "extra_file", `Extra file ${file} is ignored.`));
  }

  const metadataTimestamp = normalizeTimestamp(args.metadata.source_as_of);
  const metadataMs = parseInstant(args.metadata.source_as_of);
  const nowMs = parseInstant(args.now);
  if (args.metadata.schema_version !== 1) errors.push(issue(null, null, "schema_version", "unsupported_schema_version"));
  if (metadataTimestamp === null) errors.push(issue(null, null, "source_as_of", "invalid_timestamp"));
  if (metadataMs !== null && nowMs !== null && metadataMs > nowMs) {
    errors.push(issue(null, null, "source_as_of", "source_as_of_in_future"));
  }
  if (!isValidTimeZone(args.metadata.timezone)) errors.push(issue(null, null, "timezone", "invalid_timezone"));
  if (args.metadata.currency !== args.orgCurrency) {
    errors.push(issue(null, null, "currency", "currency_mismatch", "Import currency must match the organization currency."));
  }
  try {
    currencyMinorDigits(args.orgCurrency);
  } catch {
    errors.push(issue(null, null, "currency", "invalid_currency"));
  }

  const suppliersById = new Map<string, RawRow>();
  const itemsById = new Map<string, RawRow>();
  const itemSkus = new Map<string, RawRow>();
  const ordersById = new Map<string, RawRow>();
  const linesById = new Map<string, RawRow>();
  const receiptIds = new Map<string, RawRow>();
  const inventoryIds = new Map<string, RawRow>();
  const demandIds = new Map<string, RawRow>();
  const contactAddresses = new Map<string, RawRow>();
  const rows = (file: ImportFile): RawRow[] => rawRows.get(file) ?? [];

  const supplierPayload: NormalizedImport["suppliers"] = [];
  for (const row of rows("suppliers.csv")) {
    const field = row.fields;
    addUnique(suppliersById, field.supplier_id ?? "", row, "supplier_id", errors);
    if (!field.name?.trim()) errors.push(issue(row.file, row.line, "name", "empty"));
    if (!["candidate", "approved", "blocked"].includes(field.purchasing_status)) {
      errors.push(issue(row.file, row.line, "purchasing_status", "invalid_enum"));
    }
    const approved = field.outreach_approved;
    if (approved !== "true" && approved !== "false") errors.push(issue(row.file, row.line, "outreach_approved", "invalid_boolean"));
    const timezone = field.contact_timezone || null;
    if (timezone !== null && !isValidTimeZone(timezone)) errors.push(issue(row.file, row.line, "contact_timezone", "invalid_timezone"));
    const contacts: NormalizedImport["suppliers"][number]["contacts"] = [];
    const email = field.email.toLowerCase();
    if (email) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push(issue(row.file, row.line, "email", "invalid_email"));
      addUnique(contactAddresses, `email:${email}`, row, "email", errors);
      contacts.push({
        channel: "email",
        normalized_address: email,
        display_name: field.contact_name || null,
        timezone,
        outreach_approved: approved === "true",
      });
    }
    if (field.phone) {
      if (!/^\+[1-9]\d{6,14}$/.test(field.phone)) errors.push(issue(row.file, row.line, "phone", "invalid_phone"));
      addUnique(contactAddresses, `phone:${field.phone}`, row, "phone", errors);
      contacts.push({
        channel: "phone",
        normalized_address: field.phone,
        display_name: field.contact_name || null,
        timezone,
        outreach_approved: approved === "true",
      });
    }
    supplierPayload.push({
      external_id: field.supplier_id,
      name: field.name,
      purchasing_status: field.purchasing_status,
      contacts,
    });
  }

  const itemPayload: NormalizedImport["items"] = [];
  for (const row of rows("items.csv")) {
    const field = row.fields;
    addUnique(itemsById, field.item_id ?? "", row, "item_id", errors);
    addUnique(itemSkus, field.sku ?? "", row, "sku", errors);
    if (!field.base_unit?.trim()) errors.push(issue(row.file, row.line, "base_unit", "empty"));
    const length = quantityField(row, "length_mm", errors);
    const width = quantityField(row, "width_mm", errors);
    const height = quantityField(row, "height_mm", errors);
    for (const [name, dimension] of [["length_mm", length], ["width_mm", width], ["height_mm", height]] as const) {
      if (dimension !== null && dimension <= 0) errors.push(issue(row.file, row.line, name, "out_of_range"));
    }
    itemPayload.push({
      external_id: field.item_id,
      sku: field.sku,
      description: field.description,
      base_unit: field.base_unit,
      specification: {
        length_mm: length ?? 0,
        width_mm: width ?? 0,
        height_mm: height ?? 0,
        material_grade: field.material_grade,
      },
    });
  }

  const orderPayload: NormalizedImport["purchase_orders"] = [];
  for (const row of rows("purchase_orders.csv")) {
    const field = row.fields;
    addUnique(ordersById, field.po_id ?? "", row, "po_id", errors);
    if (!suppliersById.has(field.supplier_id)) errors.push(issue(row.file, row.line, "supplier_id", "missing_reference"));
    if (field.currency !== args.metadata.currency || field.currency !== args.orgCurrency) {
      errors.push(issue(row.file, row.line, "currency", "currency_mismatch"));
    }
    if (!["open", "closed", "cancelled"].includes(field.status)) errors.push(issue(row.file, row.line, "status", "invalid_enum"));
    orderPayload.push({
      external_id: field.po_id,
      supplier_external_id: field.supplier_id,
      currency: field.currency,
      status: field.status,
    });
  }

  const locationExternalIds = new Set(args.knownLocations.map((location) => location.externalId));
  const linePayload: NormalizedImport["purchase_order_lines"] = [];
  const lineQuantities = new Map<string, { ordered: number | null; received: number | null; cancelled: number | null; row: RawRow }>();
  for (const row of rows("purchase_order_lines.csv")) {
    const field = row.fields;
    const key = `${field.po_id}\u0000${field.line_id}`;
    addUnique(linesById, key, row, "line_id", errors);
    if (!ordersById.has(field.po_id)) errors.push(issue(row.file, row.line, "po_id", "missing_reference"));
    if (!itemsById.has(field.item_id)) errors.push(issue(row.file, row.line, "item_id", "missing_reference"));
    if (!locationExternalIds.has(field.location_id)) errors.push(issue(row.file, row.line, "location_id", "missing_reference"));
    const ordered = quantityField(row, "ordered_qty", errors);
    const received = quantityField(row, "received_qty", errors);
    const cancelled = quantityField(row, "cancelled_qty", errors);
    if (ordered !== null && received !== null && cancelled !== null && received + cancelled > ordered) {
      errors.push(issue(row.file, row.line, "received_qty", "received_cancelled_exceeds_ordered"));
    }
    lineQuantities.set(key, { ordered, received, cancelled, row });
    let price: string;
    try {
      price = parseMinorUnits(field.unit_price_minor).toString();
    } catch (error) {
      errors.push(issue(row.file, row.line, "unit_price_minor", error instanceof DomainValidationError ? error.code : "invalid_money"));
      price = "0";
    }
    const due = timestampField(row, "original_due_at", errors, true);
    linePayload.push({
      po_external_id: field.po_id,
      external_line_id: field.line_id,
      item_external_id: field.item_id,
      location_external_id: field.location_id,
      ordered_qty: ordered ?? 0,
      received_qty: received ?? 0,
      cancelled_qty: cancelled ?? 0,
      unit_price_minor: price,
      original_due_at: due,
    });
  }

  const receiptPayload: NormalizedImport["receipt_schedules"] = [];
  const scheduledByLine = new Map<string, number>();
  const scheduledRowByLine = new Map<string, RawRow>();
  for (const row of rows("receipt_schedules.csv")) {
    const field = row.fields;
    addUnique(receiptIds, field.receipt_id ?? "", row, "receipt_id", errors);
    const lineKey = `${field.po_id}\u0000${field.line_id}`;
    if (!linesById.has(lineKey)) errors.push(issue(row.file, row.line, "line_id", "missing_reference"));
    const quantity = quantityField(row, "quantity_remaining", errors);
    const earliest = timestampField(row, "earliest_at", errors, true);
    const latest = timestampField(row, "latest_at", errors, true);
    const earliestMs = earliest === null ? null : parseInstant(earliest);
    const latestMs = latest === null ? null : parseInstant(latest);
    if (earliestMs !== null && latestMs !== null && earliestMs > latestMs) {
      errors.push(issue(row.file, row.line, "earliest_at", "receipt_window_inverted"));
    }
    if (!["confirmed", "estimated", "unknown"].includes(field.promise_state)) {
      errors.push(issue(row.file, row.line, "promise_state", "invalid_enum"));
    }
    if (quantity !== null) {
      scheduledByLine.set(lineKey, (scheduledByLine.get(lineKey) ?? 0) + quantity);
      scheduledRowByLine.set(lineKey, row);
    }
    receiptPayload.push({
      external_id: field.receipt_id,
      po_external_id: field.po_id,
      external_line_id: field.line_id,
      quantity_remaining: quantity ?? 0,
      earliest_at: earliest,
      latest_at: latest,
      promise_state: field.promise_state,
      source_reference: field.source_reference,
      locator: `${row.file}:row ${row.line}`,
      row_hash: hash(JSON.stringify(row.values)),
    });
  }
  for (const [key, quantity] of scheduledByLine) {
    const line = lineQuantities.get(key);
    if (!line || line.ordered === null || line.received === null || line.cancelled === null) continue;
    if (quantity > line.ordered - line.received - line.cancelled) {
      const sourceRow = scheduledRowByLine.get(key);
      errors.push(issue("receipt_schedules.csv", sourceRow?.line ?? null, "quantity_remaining", "schedule_exceeds_remaining", `Schedule total for ${key.replace("\u0000", "/")} exceeds remaining quantity.`));
    }
  }

  const inventoryPayload: NormalizedImport["inventory"] = [];
  for (const row of rows("inventory.csv")) {
    const field = row.fields;
    const key = `${field.item_id}\u0000${field.location_id}`;
    addUnique(inventoryIds, key, row, "item_id", errors);
    if (!itemsById.has(field.item_id)) errors.push(issue(row.file, row.line, "item_id", "missing_reference"));
    if (!locationExternalIds.has(field.location_id)) errors.push(issue(row.file, row.line, "location_id", "missing_reference"));
    const physical = quantityField(row, "physical_qty", errors);
    const unusable = quantityField(row, "unusable_qty", errors);
    const outside = quantityField(row, "outside_allocations_qty", errors);
    if (physical !== null && unusable !== null && outside !== null && unusable + outside > physical) {
      errors.push(issue(row.file, row.line, "outside_allocations_qty", "contradictory_stock"));
    }
    const sourceAsOf = timestampField(row, "source_as_of", errors);
    if (sourceAsOf) inFutureChecks(row, "source_as_of", sourceAsOf, nowMs, metadataMs, errors, warnings);
    inventoryPayload.push({
      item_external_id: field.item_id,
      location_external_id: field.location_id,
      physical_qty: physical ?? 0,
      unusable_qty: unusable ?? 0,
      outside_allocations_qty: outside ?? 0,
      source_as_of: sourceAsOf ?? "",
    });
  }

  const demandPayload: NormalizedImport["demand"] = [];
  const demandKeys = new Set<string>();
  for (const row of rows("demand.csv")) {
    const field = row.fields;
    addUnique(demandIds, field.demand_id ?? "", row, "demand_id", errors);
    if (!itemsById.has(field.item_id)) errors.push(issue(row.file, row.line, "item_id", "missing_reference"));
    if (!locationExternalIds.has(field.location_id)) errors.push(issue(row.file, row.line, "location_id", "missing_reference"));
    const remaining = quantityField(row, "remaining_qty", errors);
    const reserved = quantityField(row, "included_reserved_qty", errors);
    if (remaining !== null && reserved !== null && reserved > remaining) {
      errors.push(issue(row.file, row.line, "included_reserved_qty", "included_reserved_exceeds_demand"));
    }
    if (!["confirmed", "forecast"].includes(field.certainty)) errors.push(issue(row.file, row.line, "certainty", "invalid_enum"));
    const requiredAt = timestampField(row, "required_at", errors);
    const sourceAsOf = timestampField(row, "source_as_of", errors);
    if (sourceAsOf) inFutureChecks(row, "source_as_of", sourceAsOf, nowMs, metadataMs, errors, warnings);
    demandKeys.add(`${field.item_id}\u0000${field.location_id}`);
    demandPayload.push({
      external_id: field.demand_id,
      item_external_id: field.item_id,
      location_external_id: field.location_id,
      remaining_qty: remaining ?? 0,
      required_at: requiredAt ?? "",
      certainty: field.certainty,
      included_reserved_qty: reserved ?? 0,
      source_as_of: sourceAsOf ?? "",
    });
  }

  const lineKeys = linePayload.map((line) => `${line.item_external_id}\u0000${line.location_external_id}`);
  for (const key of new Set([...demandKeys, ...lineKeys])) {
    if (!inventoryIds.has(key)) {
      errors.push(issue("inventory.csv", null, "item_id", "missing_inventory_snapshot", `No inventory snapshot exists for item/location ${key.replace("\u0000", "/")}.`));
    }
  }

  const normalizedMetadata = {
    schema_version: 1 as const,
    source_as_of: metadataTimestamp ?? args.metadata.source_as_of,
    timezone: args.metadata.timezone,
    currency: args.metadata.currency,
  };
  const canonicalFiles = Object.entries(files)
    .map(([name, content]) => [name, content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n")] as const)
    .sort(([left], [right]) => compareText(left, right));
  const contentHash = hash(JSON.stringify({
    metadata: normalizedMetadata,
    files: canonicalFiles,
  }));

  const payload: NormalizedImport = {
    suppliers: supplierPayload,
    items: itemPayload,
    purchase_orders: orderPayload,
    purchase_order_lines: linePayload,
    receipt_schedules: receiptPayload,
    inventory: inventoryPayload,
    demand: demandPayload,
    metadata: normalizedMetadata,
  };
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    counts,
    payload: errors.length === 0 ? payload : null,
    contentHash,
  };
}
