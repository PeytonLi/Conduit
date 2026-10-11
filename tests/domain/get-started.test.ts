import { describe, expect, it } from "vitest";
import { getStartedCompletion } from "@/lib/ui/get-started";

describe("Get started completion", () => {
  it("completes Gmail only for a connected Gmail row, not environment readiness or another provider", () => {
    expect(getStartedCompletion(
      [{ provider: "gmail", status: "healthy" }],
      { datasets: [] },
      [],
    ).gmail).toBe(true);
    expect(getStartedCompletion(
      [{ provider: "gmail", status: "degraded" }],
      { datasets: [] },
      [],
    ).gmail).toBe(true);
    expect(getStartedCompletion(
      [{ provider: "elevenlabs", status: "healthy" }],
      { datasets: [] },
      [],
    ).gmail).toBe(false);
    expect(getStartedCompletion(
      [{ provider: "gmail", status: "disconnected" }],
      { datasets: [] },
      [],
    ).gmail).toBe(false);
  });

  it("keeps the existing data and verified-contact completion criteria", () => {
    expect(getStartedCompletion([], { datasets: [] }, []).businessData).toBe(false);
    expect(getStartedCompletion(
      [],
      { datasets: [{ id: "active-dataset" }] },
      [],
    ).businessData).toBe(true);
    expect(getStartedCompletion(
      [],
      { datasets: [] },
      [{ contacts: [{ identity_verified: true }] }],
    ).supplierContacts).toBe(true);
    expect(getStartedCompletion(
      [],
      { datasets: [] },
      [{ contacts: [{ identity_verified: false }] }],
    ).supplierContacts).toBe(false);
  });
});
