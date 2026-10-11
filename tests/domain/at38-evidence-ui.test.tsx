import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EvidenceDrawer } from "@/components/EvidenceDrawer";
import { DisconnectGmailButton } from "@/components/DisconnectGmailButton";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

describe("AT-38 evidence and connection controls", () => {
  it("shows Source expired instead of the open-file action", () => {
    const html = renderToStaticMarkup(createElement(EvidenceDrawer, {
      evidence: {
        id: "evidence-1",
        source_type: "email",
        locator: null,
        supported_excerpt: "Supplier email summary",
        source_time: null,
        captured_at: "2026-10-12T12:00:00.000Z",
        has_file: true,
        source_expired: true,
        verified_at: null,
        purpose: "quote",
      },
      timeZone: "UTC",
    }));
    expect(html).toContain("Source expired");
    expect(html).not.toContain("Open original file");
    expect(html).toContain("Supplier email summary");
  });

  it("renders the owner Gmail disconnect control", () => {
    const html = renderToStaticMarkup(createElement(DisconnectGmailButton));
    expect(html).toContain(">Disconnect</button>");
  });
});
