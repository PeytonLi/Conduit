import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  storeErpConnection: vi.fn(),
  AuthenticationError: class extends Error {},
  AuthorizationError: class extends Error {},
  ErpNotConfiguredError: class extends Error {},
}));

vi.mock("@/lib/auth/membership", () => ({
  requireMembership: mocks.requireMembership,
  AuthenticationError: mocks.AuthenticationError,
  AuthorizationError: mocks.AuthorizationError,
}));

vi.mock("@/lib/integrations/business/live/connections", () => ({
  storeErpConnection: mocks.storeErpConnection,
  ErpNotConfiguredError: mocks.ErpNotConfiguredError,
}));

import { POST } from "@/app/api/auth/odoo/connect/route";

// Mocked HTTP: global fetch stands in for Odoo.
const body = { url: "https://acme.odoo.example", database: "acme", username: "admin", api_key: "k".repeat(40) };
const post = (payload: unknown) =>
  POST(new Request("https://app.example.test/api/auth/odoo/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://app.example.test", Host: "app.example.test" },
    body: JSON.stringify(payload),
  }));

function stubOdoo(contextStatus = 200) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path === "/web/version") return Response.json({ version_info: [20, 0, 0, "final", 0, ""], version: "20.0" });
    if (path.endsWith("/context_get")) return Response.json(contextStatus === 200 ? { uid: 2 } : { name: "Unauthorized", message: "bad key" }, { status: contextStatus });
    if (path.endsWith("res.users/read")) return Response.json([{ id: 2, login: "admin" }]);
    return Response.json(1);
  }));
}

describe("POST /api/auth/odoo/connect", () => {
  beforeEach(() => {
    vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "test-publishable-key");
    vi.stubEnv("SUPABASE_SECRET_KEY", "test-secret-key");
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", `v1:${Buffer.alloc(32, 7).toString("base64")}`);
    mocks.requireMembership.mockResolvedValue({ orgId: "org-1", userId: "user-1", role: "owner" });
    mocks.storeErpConnection.mockResolvedValue({ connectionId: "conn-1" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("verifies the credentials with Odoo, then stores them", async () => {
    stubOdoo();
    const response = await post(body);
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ connected: true });
    expect(mocks.storeErpConnection).toHaveBeenCalledWith(expect.objectContaining({
      orgId: "org-1",
      actorUserId: "user-1",
      provider: "odoo",
      externalAccountId: "acme.odoo.example/acme",
      credentials: body,
    }));
  });

  it("does not store credentials Odoo rejects", async () => {
    stubOdoo(401);
    const response = await post(body);
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("odoo_invalid_credentials");
    expect(mocks.storeErpConnection).not.toHaveBeenCalled();
  });

  it("is not configured without a credential key", async () => {
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", "");
    const response = await post(body);
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("business_not_configured");
  });

  it("rejects incomplete bodies and private addresses in production", async () => {
    expect((await post({ url: body.url })).status).toBe(422);
    vi.stubEnv("NODE_ENV", "production");
    const response = await post({ ...body, url: "http://127.0.0.1:8069" });
    expect((await response.json()).error.code).toBe("url_not_allowed");
  });

  it("is owner only", async () => {
    mocks.requireMembership.mockRejectedValue(new mocks.AuthorizationError("no"));
    expect((await post(body)).status).toBe(403);
  });
});
