import { expect, test } from "@playwright/test";

test("login renders", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
});

test("unauthenticated workspace requests redirect to login", async ({ page }) => {
  await page.goto("/cases");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("signup stays on the public auth surface", async ({ page }) => {
  await page.goto("/signup");
  await expect(page).toHaveURL(/\/signup/);
  await expect(page.getByRole("heading", { name: "Create account" })).toBeVisible();
});
