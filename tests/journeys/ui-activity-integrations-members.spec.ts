import { expect, test, type Route } from "@playwright/test";
import { Client } from "pg";
import { login, resetDemo } from "./ui-helpers";

test("activity uses event titles from the labels map", async ({ page }) => {
  await login(page, "owner@harbor.example");
  await resetDemo(page);
  await page.goto("/activity");

  const activity = page.getByRole("table", { name: "Organization activity" });
  await expect(activity.getByRole("cell", { name: "Plan ready for approval", exact: true }).first()).toBeVisible();
  await expect(page.getByLabel("Event")).toHaveValue("");
  await expect(page.getByLabel("Event").locator('option[value="action.submitted"]')).toHaveText(
    "Supplier call started",
  );
  await expect(activity.getByRole("link", { name: "Open case" }).first()).toHaveCSS("white-space", "nowrap");
});

test("replay integrations show neutral provider status", async ({ page }) => {
  await login(page, "owner@harbor.example");
  await page.goto("/settings/integrations");

  const providers = page.getByRole("region", { name: "Provider status" });
  await expect(providers.getByText("Not needed in replay").first()).toBeVisible();
  await expect(providers.getByText("Needs setup")).toHaveCount(0);
  await expect(providers.getByRole("button", { name: "Connect Gmail" })).toHaveCount(0);
});

test("connected Gmail asks for inline confirmation before disconnecting", async ({ page }) => {
  await login(page, "owner@harbor.example");
  const database = new Client({
    connectionString:
      process.env.TEST_DATABASE_URL ??
      process.env.DATABASE_URL ??
      "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  });
  await database.connect();

  let originalConnection: {
    id: string;
    status: string;
    capabilities: Record<string, boolean>;
    last_success_at: Date | string | null;
  } | null = null;
  let insertedConnectionId: string | null = null;
  let pendingDelete: Route | null = null;

  try {
    const owner = await database.query<{ org_id: string }>(
      `select memberships.org_id
       from public.memberships as memberships
       join auth.users as users on users.id = memberships.auth_user_id
       where users.email = $1 and memberships.active = true and memberships.role = 'owner'
       limit 1`,
      ["owner@harbor.example"],
    );
    const orgId = owner.rows[0]?.org_id;
    if (!orgId) throw new Error("Harbor owner organization was not found");

    const existing = await database.query<{
      id: string;
      status: string;
      capabilities: Record<string, boolean>;
      last_success_at: Date | string | null;
    }>(
      `select id, status, capabilities, last_success_at
       from public.connections
       where org_id = $1 and provider = 'gmail'
       order by created_at
       limit 1`,
      [orgId],
    );
    const syncTime = "2026-10-11T03:29:00.000Z";
    const capabilities = JSON.stringify({ gmail_read: true, gmail_send: true });
    if (existing.rows[0]) {
      originalConnection = existing.rows[0];
      await database.query(
        `update public.connections
         set status = 'healthy', capabilities = $2::jsonb, last_success_at = $3
         where id = $1`,
        [originalConnection.id, capabilities, syncTime],
      );
    } else {
      const inserted = await database.query<{ id: string }>(
        `insert into public.connections
          (org_id, provider, external_account_id, status, scopes, capabilities, last_success_at)
         values ($1, 'gmail', 'gmail-e2e-disconnect-flow', 'healthy',
          array['gmail.readonly', 'gmail.send'], $2::jsonb, $3)
         returning id`,
        [orgId, capabilities, syncTime],
      );
      insertedConnectionId = inserted.rows[0].id;
    }

    await page.goto("/settings/integrations");
    const providers = page.getByRole("region", { name: "Provider status" });
    await expect(providers.getByText("Last synced Sat, Oct 10, 8:29 PM", { exact: true })).toBeVisible();
    await expect(providers.getByText("Read ✓", { exact: true })).toBeVisible();
    await expect(providers.getByText("Send ✓", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    const confirmation = page.getByRole("group", { name: "Gmail disconnect confirmation" });
    await expect(confirmation).toContainText(
      "Disconnect Gmail? Conduit will stop reading and sending supplier email.",
    );
    await expect(confirmation.getByRole("button", { name: "Disconnect", exact: true })).toBeVisible();
    await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeVisible();
    await confirmation.getByRole("button", { name: "Cancel" }).click();
    await expect(confirmation).toHaveCount(0);

    await page.route("**/api/v1/connections/gmail", async (route) => {
      if (route.request().method() === "DELETE") pendingDelete = route;
      else await route.continue();
    });
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    await confirmation.getByRole("button", { name: "Disconnect", exact: true }).click();
    const pendingButton = confirmation.getByRole("button", { name: "Disconnecting…" });
    await expect(pendingButton).toBeDisabled();
    await expect(confirmation).toHaveAttribute("aria-busy", "true");
    await expect.poll(() => Boolean(pendingDelete)).toBe(true);
    await pendingDelete!.fulfill({ status: 503, contentType: "application/json", body: "{}" });
    await expect(confirmation.getByRole("alert")).toHaveText(
      "Gmail couldn’t be disconnected. Please try again.",
    );
  } finally {
    await page.unroute("**/api/v1/connections/gmail");
    if (insertedConnectionId) {
      await database.query("delete from public.connections where id = $1", [insertedConnectionId]);
    } else if (originalConnection) {
      await database.query(
        `update public.connections
         set status = $2, capabilities = $3::jsonb, last_success_at = $4
         where id = $1`,
        [
          originalConnection.id,
          originalConnection.status,
          JSON.stringify(originalConnection.capabilities),
          originalConnection.last_success_at,
        ],
      );
    }
    await database.end();
  }
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
