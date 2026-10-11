import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { login } from "./ui-helpers";

test("missing cases use the not-found screen without browser errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await login(page, "owner@harbor.example");
  await page.goto(`/cases/${randomUUID()}`);
  await expect(page.getByRole("heading", { name: "Case not found" })).toBeVisible();
  await expect(page.getByText("It may have been closed, or you may not have access.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to cases" })).toBeVisible();
  expect(errors).toEqual([]);
});
