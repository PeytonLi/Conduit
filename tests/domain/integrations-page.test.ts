import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

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
  humanLabel: (_kind: string, value: string) => value === "gmail" ? "Gmail" : value,
}));

import IntegrationsSettingsPage from "@/app/(workspace)/settings/integrations/page";

const owner = { orgId: "org-1", userId: "owner-1", role: "owner" };
const ready = { ready: true, missing: [] };
const configuredCapabilities = {
  gmail: ready,
};

function healthyGmail(status = "healthy") {
  return {
    provider: "gmail",
    status,
    last_success_at: "2026-10-11T03:29:00.000Z",
    last_error_code: null,
    last_error_message: null,
    capabilities: { gmail_read: true, gmail_send: true },
  };
}

async function renderPage(
  searchParams: { gmail?: string; code?: string } = {},
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
});
