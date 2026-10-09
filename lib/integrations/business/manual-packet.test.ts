import { describe, expect, it } from "vitest";
import { createCsvSnapshotConnector } from "./csv-snapshot";
import { buildManualExecutionPacket, csvCell } from "./manual-packet";

const input = {
  orgId: "o",
  caseId: "c",
  planId: "p",
  planVersion: 2,
  actionId: "a",
  currency: "USD",
  grossCommitmentMinor: "7500",
  generatedAt: "2026-10-12T15:00:00.000Z",
  steps: [
    {
      step_id: "amend",
      kind: "amend_delivery_schedule",
      item_id: "i",
      quantity: 600,
      unit: "carton",
      destination_location_id: "l",
      depends_on_step_ids: [],
      payload: { note: "=HYPERLINK(\"http://evil\")" },
    },
  ],
};

describe("manual execution packet (CSV snapshot connector)", () => {
  it("escapes spreadsheet formula prefixes", () => {
    for (const prefix of ["=", "+", "-", "@", "\t", "\r"]) {
      expect(csvCell(`${prefix}1+1`).replace(/^"/, "").startsWith("'")).toBe(true);
    }
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
  });

  it("is a manual handoff, never an applied change", async () => {
    const packet = buildManualExecutionPacket(input);
    expect(packet.status).toBe("manual_handoff");
    expect(packet.json.status).toBe("manual_handoff");
    expect(packet.csv).not.toMatch(/(^|,)=/m);
    expect(packet.csv.split("\r\n")[1]).toContain("600");

    const connector = createCsvSnapshotConnector();
    expect(connector.capabilities.can_write).toBe(false);
    const applied = (await connector.applyApprovedChange({
      orgId: "o",
      caseId: "c",
      actionId: "a",
      expectedVersion: 1,
      payload: input,
    })) as { status: string; applied: boolean };
    expect(applied.status).toBe("manual_handoff");
    expect(applied.applied).toBe(false);
  });
});
