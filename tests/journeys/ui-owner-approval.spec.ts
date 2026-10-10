import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { login } from "./ui-helpers";

let caseId: string;

test.beforeAll(() => {
  const output = execFileSync("pnpm", [
    "exec",
    "tsx",
    join(process.cwd(), "tests/journeys/demo-test-support.ts"),
    "seed-approval",
  ], { encoding: "utf8" });
  caseId = (JSON.parse(output) as { case_id: string }).case_id;
});

test("AT-28/J owner approval result survives a delayed stale detail poll", async ({ page }) => {
  await login(page, "owner@harbor.example");
  await page.goto("/cases");
  await expect(page.getByText("Replay").first()).toBeVisible();
  await expect(page.getByText("Replay clock: Mon, Oct 12, 8:00 AM PDT")).toBeVisible();
  await expect(page.getByText("Wed, Oct 14, 9:00 AM PDT").first()).toBeVisible();
  await expect(page.getByText("600 cartons").first()).toBeVisible();
  await page.locator(`a[href="/cases/${caseId}"]`).first().click();
  await expect(page.getByRole("heading", { name: /600 cartons are needed/i })).toBeVisible();
  await expect(page.getByText("Specification: 300 × 200 × 150 mm · KRAFT-SW-DEMO")).toBeVisible();
  await expect(page.getByText("Replay clock: Mon, Oct 12, 8:00 AM PDT")).toBeVisible();
  await expect(page.getByRole("table", { name: "Sources linked to this case" })).toBeVisible();
  await expect(page.getByText("Ready for approval").first()).toBeVisible();
  await expect(page.getByText("Replay: approving records the decision in the demo only; no supplier or business system is contacted.")).toBeVisible();
  await expect(page.getByRole("table", { name: /Projected usable stock/i }).getByText("−200")).toBeVisible();
  await expect(page.getByText(/Bay Carton/).first()).toBeVisible();
  await expect(page.getByText(/North Packaging/).first()).toBeVisible();
  const detailResponse = await page.request.get(`/api/v1/cases/${caseId}`);
  const detailEnvelope = await detailResponse.json() as {
    data?: {
      case: { row_version: number };
      plan: {
        plan_id: string;
        plan_version: number;
        row_version: number;
        input_fingerprint: string;
      };
    };
  };
  expect(detailResponse.ok(), JSON.stringify(detailEnvelope)).toBeTruthy();
  const detail = detailEnvelope.data!;
  expect(detail, JSON.stringify(detailEnvelope)).toBeDefined();
  const planId = detail.plan.plan_id as string;
  let approveCount = 0;
  page.on("request", (request) => {
    if (request.url().includes(`/api/v1/plans/${planId}/approve`)) {
      approveCount++;
      expect(request.headers()["idempotency-key"]).toBeTruthy();
    }
  });
  let stalePollRequestStarted = false;
  let staleResponseDelivered = false;
  let releaseStaleResponse!: () => void;
  const staleResponseGate = new Promise<void>((resolve) => {
    releaseStaleResponse = resolve;
  });
  await page.route(`**/api/v1/cases/${caseId}`, async (route) => {
    if (route.request().method() !== "GET" || stalePollRequestStarted) {
      await route.continue();
      return;
    }
    stalePollRequestStarted = true;
    await staleResponseGate;
    const response = await route.fetch();
    const envelope = await response.json() as {
      data?: { plan?: { row_version?: number } | null };
    };
    const currentPlan = envelope.data?.plan;
    if (!currentPlan || typeof currentPlan.row_version !== "number") {
      throw new Error("Plan row version was missing from case detail.");
    }
    currentPlan.row_version += 1;
    await route.fulfill({ response, json: envelope });
    staleResponseDelivered = true;
  });
  await expect.poll(() => stalePollRequestStarted, { timeout: 7_000 }).toBe(true);
  await expect(page.getByRole("button", { name: "Approve this plan" })).toBeVisible();
  await page.getByRole("button", { name: "Approve this plan" }).click();
  await expect(page.getByRole("dialog", { name: /Confirm recovery plan approval/ })).toBeVisible();
  await page.getByRole("button", { name: "Confirm approval" }).dblclick();
  const approvalStatus = page.getByRole("status").filter({ hasText: /^Plan approved\. Approval valid until / });
  await expect(approvalStatus).toBeVisible({ timeout: 10_000 });
  releaseStaleResponse();
  await expect.poll(() => staleResponseDelivered, { timeout: 5_000 }).toBe(true);
  await page.waitForTimeout(4_000);
  await expect(approvalStatus).toBeVisible();
  expect(approveCount).toBe(1);
  await expect(page.getByText("Approved").first()).toBeVisible();
  const approved = await page.request.get(`/api/v1/cases/${caseId}`);
  const approvedData = (await approved.json() as { data: { plan: { status: string } } }).data;
  expect(approvedData.plan.status).toBe("approved");
});
