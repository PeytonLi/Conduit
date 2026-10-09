import { expect, test } from "@playwright/test";
import { login, resetDemo } from "./ui-helpers";

test("AT-42 filtered-empty and failed refresh preserve successful rows", async ({ page }) => {
  await login(page, "owner@harbor.example");
  const caseId = await resetDemo(page);
  await page.goto("/cases?q=zzznomatch");
  await expect(page.locator('section[data-state="filtered-empty"]')).toContainText("No cases match these filters.");
  await page.goto("/cases");
  await expect(page.locator(`a[href="/cases/${caseId}"]`).first()).toBeVisible();
  await page.route("**/api/v1/cases?*", (route) => route.abort());
  await page.getByLabel("Search by PO, SKU, supplier or case ID").fill("refresh-failure");
  await expect(page.locator('[data-state="failed-refresh"]')).toBeVisible();
  await expect(page.locator(`a[href="/cases/${caseId}"]`).first()).toBeVisible();
  await expect(page.getByText("No problems")).toHaveCount(0);
});

test("AT-42 empty organization is distinct from filtered-empty", async ({ page }) => {
  await login(page, "owner@harbor.example");
  await resetDemo(page);
  await page.getByRole("button", { name: "Sign out" }).click();
  await login(page, "other-owner@other.example");
  await page.goto("/cases");
  await expect(page.locator('section[data-state="empty-org"]')).toContainText("No cases yet.");
  await expect(page.getByRole("link", { name: /demo scenario/i })).toBeVisible();
});

test("AT-42 stale plan polling and 409 require review", async ({ page }) => {
  await login(page, "owner@harbor.example");
  const caseId = await resetDemo(page);
  const initial = await page.request.get(`/api/v1/cases/${caseId}`);
  const data = (await initial.json()).data;
  await page.route(`**/api/v1/cases/${caseId}`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      api_schema_version: 1,
      request_id: "stale",
      data: { case: { row_version: data.case.row_version + 1 }, plan: { row_version: data.plan.row_version } },
    }),
  }));
  await page.goto(`/cases/${caseId}`);
  await expect(page.getByRole("status").filter({
    hasText: /^This plan changed; review the updated terms\.$/,
  })).toBeVisible({ timeout: 7000 });
  await expect(page.getByRole("button", { name: "Approve this plan" })).toBeDisabled();

  await page.unroute(`**/api/v1/cases/${caseId}`);
  await page.route("**/api/v1/plans/*/approve", (route) => route.fulfill({
    status: 409,
    contentType: "application/json",
    body: JSON.stringify({ api_schema_version: 1, request_id: "conflict", error: { code: "stale_version" } }),
  }));
  await page.reload();
  await page.getByRole("button", { name: "Approve this plan" }).click();
  await page.getByRole("button", { name: "Confirm approval" }).click();
  await expect(page.getByRole("status").filter({
    hasText: /^This plan changed; review the updated terms\.$/,
  })).toBeVisible();
});
