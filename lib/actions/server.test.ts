import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAdapterForMode } from "./dispatcher";
import { isReplayAdapter } from "./replay";
import { serverLedger } from "./server";

vi.mock("server-only", () => ({}));

describe("server adapter registration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("registers supplier email and call adapters for sandbox while retaining replay adapters", () => {
    vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "publishable-placeholder");
    vi.stubEnv("SUPABASE_SECRET_KEY", "secret-placeholder");

    serverLedger();

    for (const kind of ["supplier_email", "supplier_call"] as const) {
      const sandboxAdapter = resolveAdapterForMode(kind, "sandbox");
      const replayAdapter = resolveAdapterForMode(kind, "replay");
      expect(sandboxAdapter.kind).toBe(kind);
      expect(isReplayAdapter(sandboxAdapter)).toBe(false);
      expect(replayAdapter.kind).toBe(kind);
      expect(isReplayAdapter(replayAdapter)).toBe(true);
    }
  });
});
