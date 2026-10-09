import { expect, test } from "@playwright/test";
import { login, resetDemo } from "./ui-helpers";

test("AT-14/J operator phone outreach enforces 200 characters and saves the default-policy draft", async ({ page }) => {
  await login(page, "owner@harbor.example");
  const caseId = await resetDemo(page);
  await page.getByRole("button", { name: "Sign out" }).click();
  await login(page, "operator@harbor.example");
  await page.goto(`/cases/${caseId}`);
  await page.getByRole("heading", { name: "Contact supplier" }).scrollIntoViewIfNeeded();

  const contact = page.getByLabel("Supplier contact");
  const bayPhone = await contact.locator("option").filter({ hasText: "Bay Carton" }).filter({ hasText: "Phone" }).getAttribute("value");
  expect(bayPhone).toBeTruthy();
  await contact.selectOption(bayPhone!);
  await page.getByLabel("Channel").selectOption("phone");
  const message = page.getByLabel("Message");
  await message.fill("x".repeat(201));
  await expect(page.getByText("Message must be 200 characters or fewer.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Prepare request" })).toBeDisabled();
  await message.fill("x".repeat(200));
  await expect(page.getByText("200/200")).toBeVisible();
  const outreachResponse = page.waitForResponse((response) =>
    response.url().includes(`/api/v1/cases/${caseId}/outreach`),
  ).then((response) => response.json() as Promise<{
    data?: { result?: string; denials?: string[] };
  }>);
  await page.getByRole("button", { name: "Prepare request" }).click();

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const minuteOfDay = Number(values.hour) * 60 + Number(values.minute);
  const inContactHours = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(values.weekday)
    && minuteOfDay >= 9 * 60 && minuteOfDay < 17 * 60;
  const expectedDenials = [
    "contact_not_approved",
    "channel_disabled",
    ...(!inContactHours ? ["outside_contact_hours"] : []),
  ];
  const result = await outreachResponse;
  expect(result?.data).toMatchObject({ result: "draft", denials: expectedDenials });
  const labels = {
    contact_not_approved: "Contact is not approved",
    channel_disabled: "Channel is disabled by policy",
    outside_contact_hours: "Outside permitted contact hours",
  };
  const expectedMessage = `Saved as draft; not sent: ${expectedDenials.map((code) => labels[code as keyof typeof labels]).join(", ")}`;
  await expect(page.getByRole("status").filter({ hasText: expectedMessage })).toBeVisible();
});
