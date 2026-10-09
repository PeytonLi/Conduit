import { expect, test } from "@playwright/test";
import { login, resetDemo } from "./ui-helpers";

test("AT-28/J owner reviews canonical case and approves (mocked F5)", async ({ page }) => {
  await login(page, "owner@harbor.example");
  const caseId = await resetDemo(page);
  await page.goto("/cases");
  await expect(page.getByText("Replay").first()).toBeVisible();
  await expect(page.getByText("Wed, Oct 14, 9:00 AM PDT").first()).toBeVisible();
  await expect(page.getByText("600 cartons").first()).toBeVisible();
  await page.locator(`a[href="/cases/${caseId}"]`).first().click();
  await expect(page.getByRole("heading", { name: /600 cartons are needed/i })).toBeVisible();
  await expect(page.getByRole("table", { name: /Projected usable stock/i }).getByText("−200")).toBeVisible();
  await expect(page.getByText(/Bay Carton/).first()).toBeVisible();
  await expect(page.getByText(/North Packaging/).first()).toBeVisible();
  const detailResponse = await page.request.get(`/api/v1/cases/${caseId}`);
  const detail = (await detailResponse.json()).data;
  const planId = detail.plan.plan_id as string;
  let approveCount = 0;
  await page.route("**/api/v1/plans/*/approve", async (route) => {
    approveCount++;
    expect(route.request().headers()["idempotency-key"]).toBeTruthy();
    const body = route.request().postDataJSON();
    expect(body).toMatchObject({
      plan_version: detail.plan.plan_version,
      input_fingerprint: detail.plan.input_fingerprint,
      approved_ceiling_minor: "7500",
      expected_version: detail.case.row_version,
    });
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ api_schema_version: 1, request_id: "mock", data: { action_id: "mock-action" } }),
    });
  });
  await page.route("**/api/v1/actions/mock-action", async (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ api_schema_version: 1, request_id: "mock", data: { state: "confirmed" } }),
  }));
  await expect(page.getByRole("button", { name: "Approve this plan" })).toBeVisible();
  await page.getByRole("button", { name: "Approve this plan" }).click();
  await expect(page.getByRole("dialog", { name: /Confirm recovery plan approval/ })).toBeVisible();
  await page.getByRole("button", { name: "Confirm approval" }).dblclick();
  await expect(page.getByRole("status").filter({ hasText: "Recovery action confirmed" }).first()).toBeVisible({ timeout: 10_000 });
  expect(approveCount).toBe(1);
  expect(planId).toBeTruthy();
});
