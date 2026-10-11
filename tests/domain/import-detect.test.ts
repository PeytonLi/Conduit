import { describe, expect, it } from "vitest";
import { detectImportType } from "@/lib/domain/import-detect";

describe("detectImportType", () => {
  it("prefers a type found in the filename", () => {
    expect(detectImportType("harbor_inventory.csv", "unrecognized,header\n1,2")).toEqual({
      type: "inventory.csv",
      source: "filename",
      needsUser: false,
    });
    expect(detectImportType("purchase_order_lines.csv", "unrecognized,header\n1,2")).toEqual({
      type: "purchase_order_lines.csv",
      source: "filename",
      needsUser: false,
    });
  });

  it("detects a type from its complete required header", () => {
    expect(detectImportType(
      "upload.csv",
      "supplier_id,name,purchasing_status,contact_name,email,phone,contact_timezone,outreach_approved",
    )).toEqual({ type: "suppliers.csv", source: "header", needsUser: false });
  });

  it("asks the user to choose a type when neither filename nor header matches", () => {
    expect(detectImportType("export.csv", "one,two\n1,2")).toEqual({
      type: null,
      source: null,
      needsUser: true,
    });
  });
});
