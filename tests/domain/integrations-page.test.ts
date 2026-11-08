import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  listConnections: vi.fn(),
  getOrganization: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requireMembership: mocks.requireMembership,
}));
vi.mock("@/lib/db/queries/connections", () => ({
  listConnections: mocks.listConnections,
}));
vi.mock("@/lib/db/queries/organization", () => ({
  getOrganization: mocks.getOrganization,
}));
vi.mock("@/lib/db/queries/labels", () => ({
  humanLabel: (_kind: string, value: string) =>
    ({ gmail: "Gmail", outlook: "Outlook" })[value] ?? value,
}));

import IntegrationsSettingsPage from "@/app/(workspace)/settings/integrations/page";

const owner = { orgId: "org-1", userId: "owner-1", role: "owner" };
const ready = { ready: true, missing: [] };
const configuredCapabilities = {
  gmail: ready,
};

function healthyGmail(status = "healthy") {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    external_account_id: "ops@harbor.example",
    is_primary: false,
    provider: "gmail",
    status,
    last_success_at: "2026-10-11T03:29:00.000Z",
    last_error_code: null,
    last_error_message: null,
    capabilities: { gmail_read: true, gmail_send: true },
  };
}

async function renderPage(
  searchParams: { gmail?: string; outlook?: string; code?: string } = {},
): Promise<string> {
  const element = await IntegrationsSettingsPage({
    searchParams: Promise.resolve(searchParams),
  });
  return renderToStaticMarkup(element);
}

describe("Integrations Gmail connection state", () => {
  beforeEach(() => {
    vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "test-publishable-key");
    vi.stubEnv("SUPABASE_SECRET_KEY", "test-secret-key");
    vi.stubEnv("APP_ENV", "sandbox");
    vi.stubEnv("GMAIL_PROVIDER", "composio");
    vi.stubEnv("COMPOSIO_API_KEY", "test-composio-key");
    vi.stubEnv("COMPOSIO_GMAIL_AUTH_CONFIG_ID", "ac_gmail");
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", `v1:${Buffer.alloc(32, 7).toString("base64")}`);
    mocks.requireMembership.mockResolvedValue(owner);
    mocks.listConnections.mockResolvedValue({
      connections: [],
      environment_capabilities: configuredCapabilities,
    });
    mocks.getOrganization.mockResolvedValue({ timezone: "UTC" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("offers an owner a connect action and never calls an unconnected Gmail account ready", async () => {
    const html = await renderPage();

    expect(html).toContain("Not connected");
    expect(html).not.toContain(">Ready<");
    expect(html).toContain(">Connect Gmail</button>");
  });

  it("offers reconnection when the Gmail row is not healthy or degraded", async () => {
    mocks.listConnections.mockResolvedValue({
      connections: [healthyGmail("revoked")],
      environment_capabilities: configuredCapabilities,
    });

    const html = await renderPage();

    expect(html).toContain("Not connected");
    expect(html).toContain(">Connect Gmail</button>");
    expect(html).not.toContain(">Disconnect</button>");
  });

  it("leaves non-owners with the ask-an-owner guidance", async () => {
    mocks.requireMembership.mockResolvedValue({ ...owner, role: "member" });

    const html = await renderPage();

    expect(html).toContain("Not connected");
    expect(html).toContain("Ask an owner to review this provider’s environment configuration.");
    expect(html).not.toContain("Connect Gmail");
  });

  it("shows missing owner configuration without offering a connect action", async () => {
    mocks.listConnections.mockResolvedValue({
      connections: [],
      environment_capabilities: { gmail: { ready: false, missing: ["COMPOSIO_API_KEY"] } },
    });

    const html = await renderPage();

    expect(html).toContain("Not connected");
    expect(html).toContain("COMPOSIO_API_KEY");
    expect(html).not.toContain("Connect Gmail");
  });

  it("does not offer connection in replay", async () => {
    vi.stubEnv("APP_ENV", "replay");

    const html = await renderPage();

    expect(html).toContain("Not needed in replay");
    expect(html).not.toContain("Connect Gmail");
    expect(html).not.toContain(">Disconnect</button>");
  });

  it("shows the connected callback notice with status semantics", async () => {
    const html = await renderPage({ gmail: "connected" });

    expect(html).toContain('role="status"');
    expect(html).toContain(
      "Gmail connected. Conduit will start reading supplier emails within a few minutes.",
    );
  });

  it("maps known callback errors and uses a safe fallback for unknown codes", async () => {
    const known = await renderPage({ gmail: "error", code: "nonce_mismatch" });
    expect(known).toContain('role="alert"');
    expect(known).toContain("The connection request could not be verified. Start again.");

    const unknown = await renderPage({ gmail: "error", code: "unexpected_code" });
    expect(unknown).toContain("Please try again or ask an owner to review the setup.");
  });

  describe("with several mailboxes", () => {
    const outlook = (over: Record<string, unknown> = {}) => ({
      ...healthyGmail(),
      id: "00000000-0000-4000-8000-000000000002",
      external_account_id: "buyer@harbor.example",
      provider: "outlook",
      is_primary: true,
      capabilities: { mail_read: true, mail_send: true },
      ...over,
    });

    beforeEach(() => {
      vi.stubEnv("MICROSOFT_CLIENT_ID", "client");
      vi.stubEnv("MICROSOFT_CLIENT_SECRET", "secret");
      vi.stubEnv("MICROSOFT_REDIRECT_URI", "https://app.example.test/api/auth/outlook/callback");
    });

    it("offers Outlook next to Gmail when the Microsoft app is configured", async () => {
      mocks.listConnections.mockResolvedValue({
        connections: [],
        environment_capabilities: { gmail: ready, outlook: ready },
      });
      const html = await renderPage();
      expect(html).toContain(">Connect Outlook</button>");
      expect(html).toContain(">Connect Gmail</button>");
      expect(html).not.toContain("Mailboxes</h2>");
    });

    it("lists every mailbox with provider, account, health and the primary marker", async () => {
      mocks.listConnections.mockResolvedValue({
        connections: [
          healthyGmail(),
          outlook(),
          outlook({
            id: "00000000-0000-4000-8000-000000000003",
            external_account_id: "old@harbor.example",
            is_primary: false,
            status: "expired",
          }),
        ],
        environment_capabilities: { gmail: ready, outlook: ready },
      });
      const html = await renderPage();

      expect(html).toContain("Mailboxes</h2>");
      for (const account of ["ops@harbor.example", "buyer@harbor.example", "old@harbor.example"]) {
        expect(html).toContain(account);
      }
      expect(html).toContain("Reconnect needed");
      expect(html).toContain(">Primary<");
      expect(html.match(/>Primary</g)).toHaveLength(1);
      // A second Outlook account can still be added.
      expect(html).toContain(">Connect another Outlook account</button>");
      expect(html).toContain(">Connect another Gmail account</button>");
    });

    it("gives owners per-mailbox controls: make primary only where it applies, remove for a dead mailbox", async () => {
      mocks.listConnections.mockResolvedValue({
        connections: [
          healthyGmail(),
          outlook({ id: "00000000-0000-4000-8000-000000000003", is_primary: false, status: "revoked" }),
          outlook(),
        ],
        environment_capabilities: { gmail: ready, outlook: ready },
      });
      const html = await renderPage();
      expect(html.match(/>Make primary</g)).toHaveLength(1); // the healthy non-primary Gmail
      expect(html.match(/>Disconnect<\/button>/g)).toHaveLength(2); // healthy Gmail + healthy primary Outlook
      expect(html.match(/>Remove<\/button>/g)).toHaveLength(1); // the revoked Outlook
    });

    it("shows members the list but no controls", async () => {
      mocks.requireMembership.mockResolvedValue({ ...owner, role: "operator" });
      mocks.listConnections.mockResolvedValue({
        connections: [healthyGmail(), outlook()],
        environment_capabilities: { gmail: ready, outlook: ready },
      });
      const html = await renderPage();
      expect(html).toContain("buyer@harbor.example");
      expect(html).not.toContain(">Make primary<");
      expect(html).not.toContain(">Disconnect</button>");
      expect(html).not.toContain("Connect another");
    });

    it("hides disconnected mailboxes and offers no Outlook connect in replay", async () => {
      mocks.listConnections.mockResolvedValue({
        connections: [outlook({ status: "disconnected" })],
        environment_capabilities: { gmail: ready, outlook: ready },
      });
      expect(await renderPage()).not.toContain("buyer@harbor.example");

      vi.stubEnv("APP_ENV", "replay");
      const replay = await renderPage();
      expect(replay).not.toContain("Connect Outlook");
      expect(replay).not.toContain("Connect another Outlook");
    });

    it("maps Outlook callback outcomes", async () => {
      mocks.listConnections.mockResolvedValue({
        connections: [],
        environment_capabilities: { gmail: ready, outlook: ready },
      });
      const connected = await renderPage({ outlook: "connected" });
      expect(connected).toContain("Outlook connected. Conduit will start reading supplier emails within a few minutes.");
      const denied = await renderPage({ outlook: "error", code: "access_denied" });
      expect(denied).toContain("Microsoft access was not granted.");
      const unknown = await renderPage({ outlook: "error", code: "something_else" });
      expect(unknown).toContain("Please try again or ask an owner to review the setup.");
    });
  });

  it("lists business systems whose app credentials are configured", async () => {
    const odooOnly = await renderPage();
    expect(odooOnly).toContain("Business system");
    expect(odooOnly).toContain("<h3>Odoo</h3>");
    expect(odooOnly).not.toContain("QuickBooks Online");
    expect(odooOnly).not.toContain("Shopify");

    vi.stubEnv("QBO_CLIENT_ID", "qbo");
    vi.stubEnv("SHOPIFY_CLIENT_ID", "shop");
    const html = await renderPage();
    expect(html).toContain("Connect QuickBooks Online");
    expect(html).toContain("<h3>Shopify</h3>");
    expect(html).not.toContain("Zoho Inventory");
  });

  it("shows a connected business system with sync and disconnect controls", async () => {
    mocks.listConnections.mockResolvedValue({
      connections: [{ ...healthyGmail(), provider: "odoo", capabilities: {} }],
      environment_capabilities: configuredCapabilities,
    });
    const html = await renderPage();
    expect(html).toContain(">Connected<");
    expect(html).toContain(">Disconnect</button>");
    expect(html).toContain("Sync now");
  });
});
