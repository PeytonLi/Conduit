import { describe, expect, it, vi } from "vitest";
import {
  COMPOSIO_GMAIL_TOOLKIT_VERSION,
  createComposioClient,
} from "@/lib/integrations/gmail/composio-client";

const { Composio } = vi.hoisted(() => ({ Composio: vi.fn() }));

vi.mock("@composio/core", () => ({ Composio }));

describe("Composio Gmail client", () => {
  it("pins the Gmail toolkit version for manual tool execution", () => {
    createComposioClient("k");

    expect(Composio).toHaveBeenCalledWith({
      apiKey: "k",
      logLevel: "error",
      toolkitVersions: { gmail: COMPOSIO_GMAIL_TOOLKIT_VERSION },
    });
  });
});
