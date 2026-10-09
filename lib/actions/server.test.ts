import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAdapterForMode } from "./dispatcher";
import { isReplayAdapter } from "./replay";
import { serverLedger } from "./server";

vi.mock("server-only", () => ({}));

describe("server adapter registration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("registers supplier_call for sandbox while retaining its replay adapter", () => {
    vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "publishable-placeholder");
    vi.stubEnv("SUPABASE_SECRET_KEY", "secret-placeholder");

    serverLedger();

    const sandboxAdapter = resolveAdapterForMode("supplier_call", "sandbox");
    const replayAdapter = resolveAdapterForMode("supplier_call", "replay");
    expect(sandboxAdapter.kind).toBe("supplier_call");
    expect(isReplayAdapter(sandboxAdapter)).toBe(false);
    expect(replayAdapter.kind).toBe("supplier_call");
    expect(isReplayAdapter(replayAdapter)).toBe(true);
  });
});
