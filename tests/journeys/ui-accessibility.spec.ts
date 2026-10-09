import { expect, test } from "@playwright/test";
import { login, resetDemo } from "./ui-helpers";

test("AT-36 keyboard-only narrow owner journey", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, "owner@harbor.example");
  const caseId = await resetDemo(page);
  await page.goto("/cases");
  let active = "";
  for (let index = 0; index < 60; index++) {
    active = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute("href") ?? "");
    if (active === `/cases/${caseId}`) break;
    await page.keyboard.press("Tab");
  }
  expect(active).toBe(`/cases/${caseId}`);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Evidence" })).toBeVisible();
  let invokerText = "";
  for (let index = 0; index < 80; index++) {
    const label = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      const text = element?.textContent?.trim() ?? "";
      return element?.tagName === "BUTTON" && text.includes("View") ? text : "";
    });
    if (label) {
      invokerText = label;
      break;
    }
    await page.keyboard.press("Tab");
  }
  expect(invokerText).toContain("View");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(":focus")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  const restoredText = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.textContent?.trim() ?? "");
  expect(restoredText).toBe(invokerText);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  for (const table of await page.getByRole("table").all()) {
    await expect(table.locator("th").first()).toBeVisible();
  }
  for (const button of await page.getByRole("button").all()) {
    await expect(button).toHaveAccessibleName(/.+/);
  }
});
