import { describe, expect, it } from "vitest";
import { humanLabel } from "@/lib/ui/labels";

describe("audit event labels", () => {
  it("describes received supplier call results", () => {
    expect(humanLabel("auditEvent", "voice.callback.recorded")).toBe("Supplier call result received");
  });

  it("describes AT-38 dispatch precondition reasons", () => {
    expect(humanLabel("dispatchReason", "connection_unavailable")).toBe("Gmail connection unavailable");
    expect(humanLabel("dispatchReason", "preparer_revoked")).toBe(
      "Action preparer no longer has access",
    );
  });
});
