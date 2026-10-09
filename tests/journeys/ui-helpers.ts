import { expect, type Page } from "@playwright/test";

export const DEMO_PASSWORD = "HarborPackLocalOnly!2026";

export async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/cases/);
}

export async function resetDemo(page: Page): Promise<string> {
  const response = await page.request.post("/api/v1/demo/run", {
    headers: {
      Origin: new URL(page.url()).origin,
      "Idempotency-Key": crypto.randomUUID(),
    },
    data: {
      fixture_id: "harbor-pack-canonical",
      reset: true,
      plan_expires_at: new Date(Math.max(
        Date.parse("2026-10-12T19:00:00Z"),
        Date.now() + 20 * 60 * 1000,
      )).toISOString(),
    },
  });
  const envelope = await response.json() as { data?: { case_id?: string } };
  expect(response.status(), JSON.stringify(envelope)).toBe(200);
  expect(envelope.data?.case_id).toBeTruthy();
  return envelope.data!.case_id!;
}
