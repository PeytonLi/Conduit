import { expect, test } from "@playwright/test";
import { login, resetDemo } from "./ui-helpers";

test("AT-17/J owner saves a policy version and viewer remains read-only", async ({ page }) => {
  await login(page, "owner@harbor.example");
  await resetDemo(page);
  await page.goto("/settings/policies");
  await page.getByLabel("Call enabled").check();
  await page.getByLabel("Reason").fill("Enable approved supplier calls");
  await page.getByRole("button", { name: "Save policy" }).click();
  await expect(page.getByRole("status").filter({ hasText: /^Policy version \d+ saved$/ })).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await login(page, "viewer@harbor.example");
  await page.goto("/settings/policies");
  await expect(page.getByText("Only an owner can edit organization policies. This page is read-only for your role.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save policy" })).toHaveCount(0);

  await page.getByRole("button", { name: "Sign out" }).click();
  await login(page, "owner@harbor.example");
  await page.goto("/settings/policies");
  await page.getByLabel("Call enabled").uncheck();
  await page.getByLabel("Reason").fill("Restore the Harbor Pack default call policy");
  await page.getByRole("button", { name: "Save policy" }).click();
  await expect(page.getByRole("status").filter({ hasText: /^Policy version \d+ saved$/ })).toBeVisible();
});
