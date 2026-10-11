import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGmailState } from "@/lib/integrations/gmail/oauth";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  link: vi.fn(),
  list: vi.fn(),
  AuthorizationError: class extends Error {},
}));

vi.mock("@/lib/auth/membership", () => ({
  requireMembership: mocks.requireMembership,
  AuthenticationError: class extends Error {},
  AuthorizationError: mocks.AuthorizationError,
}));

vi.mock("@/lib/integrations/gmail/composio-client", () => ({
  createComposioClient: () => ({
    connectedAccounts: { link: mocks.link, list: mocks.list },
  }),
}));

import { POST } from "@/app/api/auth/gmail/connect/route";
import { GET } from "@/app/api/auth/gmail/callback/route";
import { DELETE } from "@/app/api/v1/connections/gmail/route";

const signingKey = `v1:${Buffer.alloc(32, 7).toString("base64")}`;
const membership = { orgId: "org-1", userId: "user-1", role: "owner" };

describe("Composio Gmail auth routes", () => {
  beforeEach(() => {
    vi.stubEnv("APP_BASE_URL", "https://app.example.test");
    vi.stubEnv("APP_ENV", "sandbox");
    vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "test-publishable-key");
    vi.stubEnv("SUPABASE_SECRET_KEY", "test-secret-key");
    vi.stubEnv("GMAIL_PROVIDER", "composio");
    vi.stubEnv("COMPOSIO_API_KEY", "test-composio-key");
    vi.stubEnv("COMPOSIO_GMAIL_AUTH_CONFIG_ID", "ac_gmail");
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", signingKey);
    mocks.requireMembership.mockResolvedValue(membership);
    mocks.link.mockReset();
    mocks.list.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("creates an org-scoped Composio link with a signed callback and redirects", async () => {
    mocks.link.mockResolvedValue({
      id: "link-1",
      redirectUrl: "https://connect.composio.dev/link-1",
    });

    const response = await POST(new Request("https://app.example.test/api/auth/gmail/connect", {
      method: "POST",
    }));
    const callback = new URL(mocks.link.mock.calls[0][2].callbackUrl);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://connect.composio.dev/link-1");
    expect(mocks.link).toHaveBeenCalledWith(
      membership.orgId,
      "ac_gmail",
      expect.objectContaining({ callbackUrl: expect.any(String) }),
    );
    expect(callback.origin + callback.pathname).toBe(
      "https://app.example.test/api/auth/gmail/callback",
    );
    expect(callback.searchParams.get("state")).toBeTruthy();
    expect(response.headers.get("set-cookie")).toContain("gmail_oauth_nonce=");
  });

  it("rejects a callback nonce mismatch before looking up a Composio account", async () => {
    const redirectUri = "https://app.example.test/api/auth/gmail/callback";
    const state = createGmailState({
      orgId: membership.orgId,
      userId: membership.userId,
      nonce: "expected-nonce",
      redirectUri,
      signingKey,
      now: () => new Date(),
    });
    const response = await GET(new Request(
      `${redirectUri}?state=${encodeURIComponent(state)}&status=success&connected_account_id=ca_1`,
      { headers: { cookie: "gmail_oauth_nonce=other-nonce" } },
    ));

    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("location")!).searchParams.get("code")).toBe(
      "nonce_mismatch",
    );
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("rejects a non-owner before running the Gmail disconnect", async () => {
    mocks.requireMembership.mockRejectedValue(new mocks.AuthorizationError());
    const response = await DELETE(new Request(
      "https://app.example.test/api/v1/connections/gmail",
      {
        method: "DELETE",
        headers: {
          origin: "https://app.example.test",
          host: "app.example.test",
          "idempotency-key": "disconnect-test",
        },
      },
    ));
    expect(response.status).toBe(403);
    expect(mocks.requireMembership).toHaveBeenCalledWith(["owner"]);
  });
});
