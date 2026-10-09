import { describe, expect, it } from "vitest";
import { registerAdapter } from "./adapters";
import { ModeViolationError, resolveAdapterForMode } from "./dispatcher";
import { asReplayAdapter, registerReplayAdapter, ReplayViolationError } from "./replay";
import type { ProviderAdapter } from "./types";

const liveCall: ProviderAdapter = {
  kind: "supplier_call",
  dispatch: async () => ({ outcome: "submitted", safeSummary: "live" }),
  findResult: async () => ({ outcome: "confirmed", safeSummary: "live" }),
};

describe("server-side replay enforcement", () => {
  it("never resolves a live adapter in replay mode", () => {
    registerAdapter(liveCall);
    expect(() => resolveAdapterForMode("supplier_call", "replay")).toThrow(ReplayViolationError);
    expect(resolveAdapterForMode("supplier_call", "sandbox")).toBe(liveCall);
    const replay = asReplayAdapter({ ...liveCall });
    registerReplayAdapter(replay);
    expect(resolveAdapterForMode("supplier_call", "replay")).toBe(replay);
  });

  it("refuses the demo ledger in live mode", () => {
    expect(() => resolveAdapterForMode("demo_ledger_amendment", "live")).toThrow(ModeViolationError);
  });
});
