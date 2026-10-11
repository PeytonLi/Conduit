import { describe, expect, it } from "vitest";
import { humanLabel } from "@/lib/ui/labels";

describe("audit event labels", () => {
  it("describes received supplier call results", () => {
    expect(humanLabel("auditEvent", "voice.callback.recorded")).toBe("Supplier call result received");
  });
});
