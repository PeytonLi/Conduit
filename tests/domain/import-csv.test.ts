import { describe, expect, it } from "vitest";
import { CsvParseError, parseCsv } from "@/lib/domain/import-csv";
import { validateImport } from "@/lib/domain/import-validate";
import { fixtureClock, harborFiles } from "./domain-test-helpers";

function validate(files = harborFiles()) {
  return validateImport({
    files,
    metadata: {
      schema_version: 1,
      source_as_of: fixtureClock,
      timezone: "America/Los_Angeles",
      currency: "USD",
    },
    orgCurrency: "USD",
    knownLocations: [{ id: "loc", externalId: "MAIN-WAREHOUSE", timezone: "America/Los_Angeles" }],
    now: fixtureClock,
  });
}

describe("CSV import parsing and validation", () => {
  it("validates the harbor fixture with normalized counts and payload", () => {
    const result = validate();
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.counts).toEqual({
      "suppliers.csv": 4,
      "items.csv": 2,
      "purchase_orders.csv": 1,
      "purchase_order_lines.csv": 1,
      "receipt_schedules.csv": 1,
      "inventory.csv": 1,
      "demand.csv": 3,
    });
    expect(result.payload?.purchase_order_lines[0].unit_price_minor).toBe("35");
    expect(result.payload?.receipt_schedules[0].locator).toBe("receipt_schedules.csv:row 2");
    expect(result.payload?.suppliers[0].contacts[0].normalized_address).toBe("alyssa@baycarton.example.com");
  });

  it("AT-02 reports missing references with source file, row, and field", () => {
    const files = harborFiles();
    files["purchase_orders.csv"] = files["purchase_orders.csv"].replace("PO-1042,BAY-CARTON", "PO-1042,UNKNOWN");
    const result = validate(files);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({
      file: "purchase_orders.csv",
      row: 2,
      field: "supplier_id",
      code: "missing_reference",
    }));
  });

  it("AT-02 rejects fractional quantities with a precise row and field", () => {
    const files = harborFiles();
    files["demand.csv"] = files["demand.csv"].replace(",400,", ",1.5,");
    const result = validate(files);
    expect(result.errors).toContainEqual(expect.objectContaining({
      file: "demand.csv",
      row: 2,
      field: "remaining_qty",
      code: "not_integer",
    }));
  });

  it("AT-02 rejects contradictory stock, timestamps without offsets, duplicate IDs, and excess schedules", () => {
    const contradictory = harborFiles();
    contradictory["inventory.csv"] = contradictory["inventory.csv"].replace(",600,0,0,", ",600,400,300,");
    expect(validate(contradictory).errors).toContainEqual(expect.objectContaining({
      file: "inventory.csv", row: 2, field: "outside_allocations_qty", code: "contradictory_stock",
    }));

    const noOffset = harborFiles();
    noOffset["demand.csv"] = noOffset["demand.csv"].replace(
      "2026-10-13T09:00:00-07:00",
      "2026-10-13T09:00:00",
    );
    expect(validate(noOffset).errors).toContainEqual(expect.objectContaining({
      file: "demand.csv", row: 2, field: "required_at", code: "invalid_timestamp",
    }));

    const duplicate = harborFiles();
    duplicate["demand.csv"] += duplicate["demand.csv"].split("\n")[1] + "\n";
    expect(validate(duplicate).errors).toContainEqual(expect.objectContaining({
      file: "demand.csv", row: 5, field: "demand_id", code: "duplicate_id",
    }));

    const excessSchedule = harborFiles();
    excessSchedule["receipt_schedules.csv"] = excessSchedule["receipt_schedules.csv"].replace(",4000,", ",5000,");
    expect(validate(excessSchedule).errors).toContainEqual(expect.objectContaining({
      file: "receipt_schedules.csv", row: 2, field: "quantity_remaining", code: "schedule_exceeds_remaining",
    }));
  });

  it("parses BOM, CRLF, escaped quotes, commas, embedded newlines, and row-start line numbers", () => {
    const parsed = parseCsv('\uFEFFleft,right\r\none,"hello,\r\n""world"""\r\ntwo,plain\r\n');
    expect(parsed.header).toEqual(["left", "right"]);
    expect(parsed.rows).toEqual([
      { line: 2, values: ["one", 'hello,\n"world"'], fields: { left: "one", right: 'hello,\n"world"' } },
      { line: 4, values: ["two", "plain"], fields: { left: "two", right: "plain" } },
    ]);
    expect(() => parseCsv('a,b\n1,"unterminated')).toThrow(CsvParseError);
  });

  it("returns file-level errors for missing required files and columns", () => {
    const missingFile = harborFiles();
    delete missingFile["items.csv"];
    expect(validate(missingFile).errors).toContainEqual(expect.objectContaining({
      file: "items.csv", row: null, code: "missing_file",
    }));

    const missingColumn = harborFiles();
    missingColumn["demand.csv"] = "demand_id,item_id\nD1,I1\n";
    expect(validate(missingColumn).errors).toContainEqual(expect.objectContaining({
      file: "demand.csv", row: null, field: "required_at", code: "missing_column",
    }));
  });

  it("canonicalizes content hashes for equal content and CRLF versus LF", () => {
    const originalFiles = harborFiles();
    const original = validate(originalFiles);
    expect(validate(originalFiles).contentHash).toBe(original.contentHash);
    const crlf = Object.fromEntries(
      Object.entries(originalFiles).map(([name, content]) => [name, content.replace(/\n/g, "\r\n")]),
    );
    expect(validate(crlf).contentHash).toBe(original.contentHash);

    const equivalentOffset = validateImport({
      files: originalFiles,
      metadata: {
        schema_version: 1,
        source_as_of: "2026-10-12T08:00:00-07:00",
        timezone: "America/Los_Angeles",
        currency: "USD",
      },
      orgCurrency: "USD",
      knownLocations: [{ id: "loc", externalId: "MAIN-WAREHOUSE", timezone: "America/Los_Angeles" }],
      now: fixtureClock,
    });
    expect(equivalentOffset.contentHash).toBe(original.contentHash);
  });
});
