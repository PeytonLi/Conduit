import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  ConnectGmailButton,
  ConnectGmailError,
  gmailConnectFailureMessage,
  requestGmailConnection,
} from "@/components/ConnectGmailButton";

describe("ConnectGmailButton", () => {
  it("assigns the authorization URL returned by the app API", async () => {
    const fetcher = vi.fn<Parameters<typeof requestGmailConnection>[0]>()
      .mockResolvedValue({
        ok: true,
        json: async () => ({
          api_schema_version: 1,
          data: { authorization_url: "https://connect.composio.dev/link-1" },
        }),
      });
    const assign = vi.fn();
    const onError = vi.fn();

    await requestGmailConnection(fetcher, assign, onError);

    expect(fetcher).toHaveBeenCalledWith("/api/auth/gmail/connect", {
      method: "POST",
      credentials: "same-origin",
    });
    expect(assign).toHaveBeenCalledWith("https://connect.composio.dev/link-1");
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports a failed connection in an alert region", async () => {
    const fetcher = vi.fn<Parameters<typeof requestGmailConnection>[0]>()
      .mockResolvedValue({ ok: false, json: async () => ({}) });
    const assign = vi.fn();
    const onError = vi.fn();

    await requestGmailConnection(fetcher, assign, onError);

    expect(assign).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(gmailConnectFailureMessage);
    const html = renderToStaticMarkup(createElement(
      ConnectGmailError,
      { message: onError.mock.calls[0][0] },
    ));
    expect(html).toContain('role="alert"');
    expect(html).toContain(gmailConnectFailureMessage);
  });

  it("reports a missing authorization URL", async () => {
    const fetcher = vi.fn<Parameters<typeof requestGmailConnection>[0]>()
      .mockResolvedValue({
        ok: true,
        json: async () => ({ api_schema_version: 1, data: {} }),
      });
    const assign = vi.fn();
    const onError = vi.fn();

    await requestGmailConnection(fetcher, assign, onError);

    expect(assign).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(gmailConnectFailureMessage);
  });

  it("renders the primary connect action", () => {
    const html = renderToStaticMarkup(createElement(ConnectGmailButton));
    expect(html).toContain(">Connect Gmail</button>");
  });
});
