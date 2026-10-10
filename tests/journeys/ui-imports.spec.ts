import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { login, resetDemo } from "./ui-helpers";

test("F1 imports: owner stages and activates a multipart CSV import through the real API", async ({ page }) => {
  await login(page, "owner@harbor.example");
  await resetDemo(page);
  await page.goto("/business-data");

  const sourceAsOf = new Date(Date.now() - 60_000).toISOString();
  await page.getByLabel(/Source data as of/).fill(sourceAsOf);
  for (const [label, file] of [
    ["Suppliers CSV", "suppliers.csv"],
    ["Items CSV", "items.csv"],
    ["Purchase orders CSV", "purchase_orders.csv"],
    ["Purchase order lines CSV", "purchase_order_lines.csv"],
    ["Receipt schedules CSV", "receipt_schedules.csv"],
    ["Inventory CSV", "inventory.csv"],
    ["Demand CSV", "demand.csv"],
  ]) {
    const contents = readFileSync(join(process.cwd(), "tests/fixtures/harbor-pack", file), "utf8")
      .replaceAll("2026-10-12T15:00:00Z", sourceAsOf);
    await page.getByLabel(label).setInputFiles({
      name: file,
      mimeType: "text/csv",
      buffer: Buffer.from(contents),
    });
  }

  const stageResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/v1/imports") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Preview import" }).click();
  const staged = await stageResponse;
  expect(staged.status()).toBe(201);
  await expect(page.getByText("Status: Staged")).toBeVisible();
  await expect(page.getByText(/suppliers.csv: \d+ rows/)).toBeVisible();

  const activateButton = page.getByRole("button", { name: "Activate import" });
  await expect(activateButton).toBeDisabled();
  await page.getByRole("checkbox", {
    name: "I confirm we have permission to use the supplier contact information in these files.",
  }).check();
  const activationResponse = page.waitForResponse((response) =>
    response.url().endsWith("/activate") && response.request().method() === "POST",
  );
  await activateButton.click();
  await expect(page.getByText("Status: Active")).toBeVisible();
  const activated = await activationResponse;
  const activation = (await activated.json()) as { data?: { import_id?: string } };
  expect(activation.data?.import_id).toBeTruthy();
  execFileSync("pnpm", [
    "exec",
    "tsx",
    join(process.cwd(), "tests/journeys/demo-test-support.ts"),
    "cleanup-import",
    activation.data!.import_id!,
  ], { stdio: "pipe" });
  await resetDemo(page);
});
