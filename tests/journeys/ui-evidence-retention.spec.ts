import { expect, test } from "@playwright/test";
import { Client } from "pg";
import { login, resetDemo } from "./ui-helpers";

test("AT-38 expired evidence keeps its summary and shows Source expired", async ({ page }) => {
  await login(page, "owner@harbor.example");
  const caseId = await resetDemo(page);
  const response = await page.request.get(`/api/v1/cases/${caseId}/evidence`);
  const envelope = await response.json() as {
    data: Array<{ id: string }>;
  };
  expect(envelope.data.length).toBeGreaterThan(0);
  const evidenceId = envelope.data[0].id;
  const database = new Client({
    connectionString:
      process.env.TEST_DATABASE_URL ??
      process.env.DATABASE_URL ??
      "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  });
  await database.connect();
  let originalRetention: Date | string | null | undefined;
  try {
    const prior = await database.query(
      "select retention_until from public.evidence where id = $1",
      [evidenceId],
    );
    if (prior.rows.length === 0) throw new Error("Evidence row was not found");
    originalRetention = prior.rows[0].retention_until;
    await database.query(
      "update public.evidence set retention_until = $2 where id = $1",
      [evidenceId, new Date(Date.now() - 60_000).toISOString()],
    );
    await page.goto(`/cases/${caseId}`);
    await page.getByRole("tab", { name: /History/ }).click();
    const sourceButton = page.getByRole("button", { name: "Source expired", exact: true }).first();
    await expect(sourceButton).toBeVisible();
    await sourceButton.click();
    const dialog = page.getByRole("dialog", { name: "Evidence source" });
    await expect(dialog).toContainText("Source expired");
    await expect(dialog).not.toContainText("Open original file");
  } finally {
    if (originalRetention !== undefined) {
      await database.query(
        "update public.evidence set retention_until = $2 where id = $1",
        [evidenceId, originalRetention],
      );
    }
    await database.end();
  }
});
