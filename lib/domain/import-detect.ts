import { parseCsv } from "./import-csv";
import { requiredColumns, type ImportFile } from "./import-schema";

export type ImportTypeDetection = {
  type: ImportFile | null;
  source: "filename" | "header" | null;
  needsUser: boolean;
};

const filenameKeywords: Record<ImportFile, string[]> = {
  "suppliers.csv": ["supplier", "suppliers"],
  "items.csv": ["item", "items", "products"],
  "purchase_orders.csv": ["purchase_order", "purchase_orders", "purchase order", "po_header"],
  "purchase_order_lines.csv": ["purchase_order_line", "purchase_order_lines", "po_line", "po_lines"],
  "receipt_schedules.csv": ["receipt_schedule", "receipt_schedules", "receipts"],
  "inventory.csv": ["inventory", "stock"],
  "demand.csv": ["demand", "requirements"],
};

export function detectImportType(filename: string, csvText: string): ImportTypeDetection {
  const normalizedName = filename.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  let filenameMatch: ImportFile | null = null;
  let filenameMatchLength = 0;
  for (const type of Object.keys(filenameKeywords) as ImportFile[]) {
    for (const keyword of filenameKeywords[type]) {
      const normalizedKeyword = keyword.toLowerCase().replace(/[^a-z0-9]+/g, "_");
      if (normalizedName.includes(normalizedKeyword) && normalizedKeyword.length > filenameMatchLength) {
        filenameMatch = type;
        filenameMatchLength = normalizedKeyword.length;
      }
    }
  }
  if (filenameMatch) return { type: filenameMatch, source: "filename", needsUser: false };

  try {
    const header = new Set(parseCsv(csvText).header);
    const headerMatch = (Object.keys(requiredColumns) as ImportFile[]).find((type) =>
      requiredColumns[type].every((column) => header.has(column)),
    );
    if (headerMatch) return { type: headerMatch, source: "header", needsUser: false };
  } catch {
    return { type: null, source: null, needsUser: true };
  }
  return { type: null, source: null, needsUser: true };
}
