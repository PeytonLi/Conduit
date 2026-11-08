import { expect, test } from "@playwright/test";
import { login } from "./ui-helpers";

test("signup page is available in replay", async ({ page }) => {
  await page.goto("/signup");
  await expect(page.getByRole("heading", { name: "Create account" })).toBeVisible();
  await expect(page.getByLabel("Organization name")).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
});

test("login links to pilot signup when enabled", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("link", { name: "Create a pilot account" })).toBeVisible();
});

test("onboarding shows connection health readiness", async ({ page }) => {
  await login(page, "owner@harbor.example");
  await page.goto("/onboarding");
  await expect(page.getByRole("heading", { name: "Connection health" })).toBeVisible();
  await expect(page.getByText("Case analysis", { exact: true })).toBeVisible();
  await expect(page.getByText("Supplier email", { exact: true })).toBeVisible();
  await expect(page.getByText("Supplier voice", { exact: true })).toBeVisible();
  await expect(page.getByText("Business write-back", { exact: true })).toBeVisible();
});

test("billing page shows pilot not billed plan", async ({ page }) => {
  await login(page, "owner@harbor.example");
  await page.goto("/settings/billing");
  await expect(page.getByRole("heading", { name: "Billing" })).toBeVisible();
  await expect(page.getByText("Not billed", { exact: true })).toBeVisible();
  await expect(page.getByText("Pilot evaluation")).toBeVisible();
  await expect(page.getByText("no payment method", { exact: false })).toBeVisible();
});

test("integrations surfaces connection health summary", async ({ page }) => {
  await login(page, "owner@harbor.example");
  await page.goto("/settings/integrations");
  await expect(page.getByRole("heading", { name: "Connection health" })).toBeVisible();
});
