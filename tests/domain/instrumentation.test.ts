import { afterEach, describe, expect, it, vi } from "vitest";
import { register } from "../../instrumentation";
import { initTelemetry } from "@/lib/telemetry";

vi.mock("@/lib/telemetry", () => ({
  initTelemetry: vi.fn(),
}));

const mockedInitTelemetry = vi.mocked(initTelemetry);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("Next instrumentation", () => {
  it("initializes telemetry in the Node.js runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");

    await register();

    expect(mockedInitTelemetry).toHaveBeenCalledTimes(1);
    expect(mockedInitTelemetry.mock.calls[0]?.[0]).toBe(process.env);
  });

  it("does not initialize telemetry in the Edge runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");

    await register();

    expect(mockedInitTelemetry).not.toHaveBeenCalled();
  });
});
