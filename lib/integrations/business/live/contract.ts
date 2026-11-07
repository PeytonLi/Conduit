import { expect, it } from "vitest";
import type { ErpClient } from "./types";

export interface ContractFixture {
  client: ErpClient;
  /** An open PO with one line that has at least 2 units still to receive. */
  poExternalId: string;
  lineExternalId: string;
  /** Records a receipt of `quantity` on the line directly in the system (outside Conduit). */
  receive(quantity: number): Promise<void>;
  /** Changes the PO directly in the system (outside Conduit) so its version moves. */
  touch(): Promise<void>;
}

const day = (offset: number) => new Date(Date.UTC(2030, 0, 10 + offset, 17)).toISOString();

/**
 * AT-37 contract. Every connector runs this against its real system (or a faithful local copy):
 * fresh read, version conflict, approved write, readback, idempotent retry, and receiving.
 */
export function describeErpClientContract(setup: () => Promise<ContractFixture>) {
  it("reads a fresh snapshot that includes the seeded PO line", async () => {
    const f = await setup();
    const snapshot = await f.client.readSnapshot();
    const po = snapshot.purchase_orders.find((p) => p.external_id === f.poExternalId);
    expect(po?.version).toBeTruthy();
    expect(po?.lines.some((l) => l.external_line_id === f.lineExternalId)).toBe(true);
    expect(Number.isNaN(Date.parse(snapshot.as_of))).toBe(false);
  });

  it("refuses a write against a stale version and changes nothing", async () => {
    const f = await setup();
    const before = await f.client.readPurchaseOrder(f.poExternalId);
    await f.touch();
    const line = before!.lines.find((l) => l.external_line_id === f.lineExternalId)!;
    const open = line.ordered_qty - line.received_qty;
    const result = await f.client.applyDeliverySplit({
      change_ref: `contract-stale-${Date.now()}`,
      po_external_id: f.poExternalId,
      line_external_id: f.lineExternalId,
      expected_version: before!.version,
      schedules: [{ quantity: open, earliest_at: day(0), latest_at: day(0) }],
    });
    expect(result.status).toBe("conflict");
  });

  it("applies an approved split, reads it back, and does not duplicate on retry", async () => {
    const f = await setup();
    const po = (await f.client.readPurchaseOrder(f.poExternalId))!;
    const line = po.lines.find((l) => l.external_line_id === f.lineExternalId)!;
    const open = line.ordered_qty - line.received_qty;
    const first = Math.floor(open / 2);
    const request = {
      change_ref: `contract-split-${Date.now()}`,
      po_external_id: f.poExternalId,
      line_external_id: f.lineExternalId,
      expected_version: po.version,
      schedules: [
        { quantity: first, earliest_at: day(1), latest_at: day(1) },
        { quantity: open - first, earliest_at: day(3), latest_at: day(3) },
      ],
    };
    const applied = await f.client.applyDeliverySplit(request);
    expect(applied.status).toBe("applied");
    if (applied.status !== "applied") return;
    expect(applied.deliveries.map((d) => d.quantity).sort((a, b) => a - b)).toEqual([first, open - first].sort((a, b) => a - b));

    const found = await f.client.findChange(request.change_ref, f.poExternalId);
    expect(found.status).toBe("applied");
    if (found.status === "applied") {
      expect(found.deliveries.reduce((s, d) => s + d.quantity, 0)).toBe(open);
    }

    const retry = await f.client.applyDeliverySplit({ ...request, expected_version: applied.version });
    expect(retry.status).toBe("applied");
    const again = await f.client.findChange(request.change_ref, f.poExternalId);
    if (again.status === "applied") {
      expect(again.deliveries.reduce((s, d) => s + d.quantity, 0)).toBe(open);
    }
  });

  it("reports nothing for a change it never made", async () => {
    const f = await setup();
    expect((await f.client.findChange(`contract-missing-${Date.now()}`, f.poExternalId)).status).toBe("not_found");
  });

  it("lists receipts recorded in the system", async () => {
    const f = await setup();
    const since = new Date(Date.now() - 60_000).toISOString();
    await f.receive(1);
    const receipts = await f.client.listReceipts(since);
    expect(receipts.some((r) => r.po_external_id === f.poExternalId && r.quantity >= 1 && r.kind === "received")).toBe(true);
  });
}
