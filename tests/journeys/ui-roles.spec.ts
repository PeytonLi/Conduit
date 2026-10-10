import { expect, test } from "@playwright/test";
import { login, resetDemo, signOut } from "./ui-helpers";

const headers = (origin: string) => ({ Origin: new URL(origin).origin, "Idempotency-Key": crypto.randomUUID() });

test("AT-14 operator sees Waiting for owner and cannot approve", async ({ page }) => {
  await login(page, "owner@harbor.example");
  const caseId = await resetDemo(page);
  await signOut(page);
  await login(page, "operator@harbor.example");
  await page.goto(`/cases/${caseId}`);
  await expect(page.getByRole("heading", { name: "Waiting for owner" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve this plan" })).toHaveCount(0);
  const control = await page.request.post(`/api/v1/cases/${caseId}/control`, {
    headers: headers(page.url()), data: { command: "close", outcome: "accepted_risk", expected_version: 1, reason: "test" },
  });
  expect(control.status()).toBe(403);
  const supplier = await page.request.post("/api/v1/suppliers/00000000-0000-4000-8000-000000000001/approval", {
    headers: headers(page.url()), data: { scope: "purchasing", decision: "approve", expected_version: 1, reason: "test" },
  });
  expect(supplier.status()).toBe(403);
  const member = await page.request.post("/api/v1/memberships/00000000-0000-4000-8000-000000000001/role", {
    headers: headers(page.url()), data: { role: "owner", active: true, expected_version: 1, reason: "test" },
  });
  expect(member.status()).toBe(403);
});

test("AT-14 viewer is read-only", async ({ page }) => {
  await login(page, "owner@harbor.example");
  const caseId = await resetDemo(page);
  await signOut(page);
  await login(page, "viewer@harbor.example");
  await page.goto(`/cases/${caseId}`);
  await page.getByText("Case options", { exact: true }).click();
  await expect(page.getByText("Read-only access.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Pause case" })).toHaveCount(0);
  const response = await page.request.post(`/api/v1/cases/${caseId}/control`, {
    headers: headers(page.url()), data: { command: "pause", expected_version: 1, reason: "test" },
  });
  expect(response.status()).toBe(403);
});

test("AT-14 other tenant gets not found", async ({ page }) => {
  await login(page, "owner@harbor.example");
  const caseId = await resetDemo(page);
  const evidenceResponse = await page.request.get(`/api/v1/cases/${caseId}/evidence`);
  const evidenceRows = (await evidenceResponse.json()).data as { id: string }[];
  const evidenceId = evidenceRows[0].id;
  await signOut(page);
  await login(page, "other-owner@other.example");
  await page.goto(`/cases/${caseId}`);
  await expect(page.getByRole("heading", { name: /not found|doesn’t exist/i })).toBeVisible();
  const caseResponse = await page.request.get(`/api/v1/cases/${caseId}`);
  expect(caseResponse.status()).toBe(404);
  const evidenceAccess = await page.request.get(`/api/v1/evidence/${evidenceId}/access`);
  expect(evidenceAccess.status()).toBe(404);
});
