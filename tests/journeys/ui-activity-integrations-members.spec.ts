import { expect, test } from "@playwright/test";
import { login, resetDemo } from "./ui-helpers";

test("activity uses event titles from the labels map", async ({ page }) => {
  await login(page, "owner@harbor.example");
  await resetDemo(page);
  await page.goto("/activity");

  const activity = page.getByRole("table", { name: "Organization activity" });
  await expect(activity.getByRole("cell", { name: "Plan ready for approval", exact: true }).first()).toBeVisible();
});

test("replay integrations show neutral provider status", async ({ page }) => {
  await login(page, "owner@harbor.example");
  await page.goto("/settings/integrations");

  const providers = page.getByRole("region", { name: "Provider status" });
  await expect(providers.getByText("Not needed in replay").first()).toBeVisible();
  await expect(providers.getByText("Needs setup")).toHaveCount(0);
});

test("member control labels remain accessible without duplicating column headings", async ({ page }) => {
  await login(page, "owner@harbor.example");
  await page.goto("/settings/members");

  const members = page.getByRole("table", { name: "Organization members" });
  await expect(members.getByRole("columnheader", { name: "Role" })).toBeVisible();
  await expect(members.getByRole("columnheader", { name: "Active" })).toBeVisible();

  const roleSelect = members.getByRole("combobox", { name: "Role" }).first();
  await expect(roleSelect).toHaveAccessibleName("Role");
  const roleId = await roleSelect.getAttribute("id");
  expect(roleId).toBeTruthy();
  await expect(members.locator(`label[for="${roleId}"]`)).toHaveCSS("clip-path", "inset(50%)");

  const activeCheckbox = members.getByRole("checkbox", { name: "Active" }).first();
  await expect(activeCheckbox).toHaveAccessibleName("Active");
  await expect(activeCheckbox.locator("xpath=..").getByText("Active", { exact: true }))
    .toHaveCSS("clip-path", "inset(50%)");
});
