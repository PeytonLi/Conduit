import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { login } from "./ui-helpers";

const importId = "30000000-0000-4000-8000-000000000001";
const datasetId = "40000000-0000-4000-8000-000000000001";
const validationSummary = { errors: [], warnings: [], counts: { "suppliers.csv": 4 } };

test("F1 imports: owner stages and activates a multipart CSV import", async ({ page }) => {
  await login(page, "owner@harbor.example");
  await page.goto("/business-data");

  let multipartBody = "";
  let stagedRead = false;
  let activationBody: Record<string, unknown> | null = null;
  let activationKey = "";
  await page.route("**/api/v1/imports**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname.endsWith("/activate")) {
      activationBody = request.postDataJSON() as Record<string, unknown>;
      activationKey = request.headers()["idempotency-key"] ?? "";
      await route.fulfill({
        status: 200,
        json: {
          data: {
            import_id: importId,
            dataset_id: datasetId,
            status: "active",
            row_version: 2,
            outcome: "activated",
          },
        },
      });
      return;
    }
    if (request.method() === "POST") {
      multipartBody = request.postDataBuffer()?.toString("utf8") ?? "";
      expect(request.headers()["content-type"]).toContain("multipart/form-data");
      expect(request.headers()["idempotency-key"]).toBeTruthy();
      await route.fulfill({
        status: 201,
        json: {
          data: {
            import_id: importId,
            status: "staged",
            row_version: 1,
            dataset_id: datasetId,
            validation_summary: validationSummary,
            preview: { counts: validationSummary.counts },
          },
        },
      });
      return;
    }

    stagedRead = true;
    await route.fulfill({
      status: 200,
      json: {
        data: {
          import_id: importId,
          status: "staged",
          row_version: 1,
          content_hash: "fixture-content-hash",
          source_as_of: "2026-10-12T15:00:00Z",
          dataset_id: datasetId,
          validation_summary: validationSummary,
          preview: { counts: validationSummary.counts },
          created_at: "2026-10-12T15:00:00Z",
          activated_at: null,
        },
      },
    });
  });

  await page.getByLabel(/Source data as of/).fill("2026-10-12T15:00:00Z");
  for (const [label, file] of [
    ["Suppliers CSV", "suppliers.csv"],
    ["Items CSV", "items.csv"],
    ["Purchase orders CSV", "purchase_orders.csv"],
    ["Purchase order lines CSV", "purchase_order_lines.csv"],
    ["Receipt schedules CSV", "receipt_schedules.csv"],
    ["Inventory CSV", "inventory.csv"],
    ["Demand CSV", "demand.csv"],
  ]) {
    await page.getByLabel(label).setInputFiles(join(process.cwd(), "tests/fixtures/harbor-pack", file));
  }

  await page.getByRole("button", { name: "Preview import" }).click();
  await expect(page.getByText("Status: Staged")).toBeVisible();
  await expect(page.getByText("suppliers.csv: 4 rows")).toBeVisible();
  expect(stagedRead).toBe(true);
  expect(multipartBody).toContain("name=\"metadata\"");
  expect(multipartBody).toContain('"schema_version":1');
  expect(multipartBody).toContain('"source_as_of":"2026-10-12T15:00:00Z"');
  for (const field of [
    "suppliers.csv",
    "items.csv",
    "purchase_orders.csv",
    "purchase_order_lines.csv",
    "receipt_schedules.csv",
    "inventory.csv",
    "demand.csv",
  ]) {
    expect(multipartBody).toContain(`name="${field}"`);
  }

  const activateButton = page.getByRole("button", { name: "Activate import" });
  await expect(activateButton).toBeDisabled();
  await page.getByRole("checkbox", {
    name: "I confirm we have permission to use the supplier contact information in these files.",
  }).check();
  await activateButton.click();
  await expect(page.getByText("Status: Active")).toBeVisible();
  expect(activationBody).toEqual({
    expected_version: 1,
    contact_permissions_confirmed: true,
  });
  expect(activationKey).toBeTruthy();
});
