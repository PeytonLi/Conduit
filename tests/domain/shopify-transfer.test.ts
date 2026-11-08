import { describe, expect, it } from "vitest";
import { shopifyProvider } from "@/lib/integrations/business/live/shopify";
import { changeStamp } from "@/lib/integrations/business/live/shopify/stamp";
import { grantsTransferExecution, shopifyScopesFor, SHOPIFY_SCOPES } from "@/lib/integrations/business/live/shopify/oauth";
import type { TransferRequest } from "@/lib/integrations/business/live/types";
import { createShopifyEmulator } from "../fixtures/shopify-emulator";

// Mocked HTTP only: proves Conduit's sequencing, stamping and reconciliation against documented
// Admin GraphQL shapes. It is not a recording of a real Shopify store.
const ITEM = "gid://shopify/InventoryItem/11";
const SOURCE = "gid://shopify/Location/3";
const DESTINATION = "gid://shopify/Location/1";

const credentials = (scope: string) => ({
  shop: "conduit-dev.myshopify.com",
  access_token: "shpat_test",
  scope,
  access_token_expires_at: null,
  refresh_token: null,
  refresh_token_expires_at: null,
});
const WRITE_SCOPE = "read_inventory,write_inventory_transfers,write_inventory_shipments";

function setup(options: { onHand?: number; available?: number } = {}) {
  const shopify = createShopifyEmulator({ now: () => new Date("2030-01-10T12:00:00Z") });
  shopify.setLevel(ITEM, SOURCE, { on_hand: options.onHand ?? 100, available: options.available });
  const client = shopifyProvider.createClient(credentials(WRITE_SCOPE), { fetch: shopify.fetch });
  return { shopify, client, api: client.transfers! };
}

const request = (overrides: Partial<TransferRequest> = {}): TransferRequest => ({
  change_ref: "00000000-0000-4000-8000-000000000001",
  item_external_id: ITEM,
  source_location_external_id: SOURCE,
  destination_location_external_id: DESTINATION,
  quantity: 40,
  arrives_at: "2030-01-12T17:00:00.000Z",
  min_source_on_hand_after: 30,
  ...overrides,
});

const writes = (shopify: ReturnType<typeof createShopifyEmulator>) =>
  shopify.requests.filter((r) => r.operationName === "ConduitTransferCreate" || r.operationName === "ConduitShipmentCreateInTransit");

describe("Shopify transfer capability", () => {
  it("is recommend-only unless the token was granted transfer and shipment write scopes", () => {
    const shopify = createShopifyEmulator();
    for (const scope of ["read_inventory", "read_inventory,write_inventory_shipments", "write_inventory_transfers"]) {
      const client = shopifyProvider.createClient(credentials(scope), { fetch: shopify.fetch });
      expect(client.transfers).toBeUndefined();
    }
    expect(shopifyProvider.createClient(credentials(WRITE_SCOPE), { fetch: shopify.fetch }).transfers?.capabilities).toEqual({
      reserve: true,
      dispatch: true,
      receive: true,
    });
  });

  it("keeps the default OAuth scopes minimal and adds the transfer scope only on request", () => {
    expect(shopifyScopesFor()).toEqual([...SHOPIFY_SCOPES]);
    expect(shopifyScopesFor()).not.toContain("write_inventory_transfers");
    expect(shopifyScopesFor({ transfers: true })).toContain("write_inventory_transfers");
    expect(grantsTransferExecution("write_inventory_transfers write_inventory_shipments")).toBe(true);
    expect(grantsTransferExecution("read_inventory")).toBe(false);
  });
});

describe("Shopify createTransfer (mocked Admin GraphQL)", () => {
  it("reserves at the source, dispatches in transit, and reads the stamped transfer back", async () => {
    const { shopify, api } = setup();
    const req = request();
    const result = await api.createTransfer(req);

    expect(result).toMatchObject({ status: "applied", state: "in_transit", quantity: 40, received_qty: 0, arrives_at: req.arrives_at });
    const [create, ship] = writes(shopify);
    expect(create.operationName).toBe("ConduitTransferCreate");
    expect(create.variables.input).toMatchObject({
      originLocationId: SOURCE,
      destinationLocationId: DESTINATION,
      lineItems: [{ inventoryItemId: ITEM, quantity: 40 }],
      referenceName: changeStamp(req.change_ref),
    });
    expect(ship.variables.input).toMatchObject({ barcode: `${changeStamp(req.change_ref)}-1of1`, trackingInput: { arrivesAt: req.arrives_at } });
    expect(create.variables.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(create.variables.idempotencyKey).not.toBe(ship.variables.idempotencyKey);
    expect(shopify.level(ITEM, SOURCE)).toMatchObject({ on_hand: 60, available: 60 });
    if (result.status === "applied") expect(result.provider_ref).toBe(`${result.transfer_external_id}#${changeStamp(req.change_ref)}`);
  });

  it("does not create a second transfer when the same change reference is replayed", async () => {
    const { shopify, api } = setup();
    const req = request();
    const first = await api.createTransfer(req);
    const again = await api.createTransfer(req);

    expect(again).toEqual(first);
    expect(shopify.transfers).toHaveLength(1);
    expect(writes(shopify)).toHaveLength(2);
    expect(shopify.level(ITEM, SOURCE)?.on_hand).toBe(60);
  });

  it("writes nothing when live stock would leave the source below the approved floor", async () => {
    const { shopify, api } = setup({ onHand: 100 });
    const result = await api.createTransfer(request({ quantity: 40, min_source_on_hand_after: 70 }));

    expect(result).toMatchObject({ status: "rejected", code: "source_stock_changed" });
    expect(writes(shopify)).toHaveLength(0);
    expect(shopify.transfers).toHaveLength(0);
  });

  it("writes nothing when the source does not have the quantity available", async () => {
    const { shopify, api } = setup({ onHand: 100, available: 10 });
    const result = await api.createTransfer(request());

    expect(result).toMatchObject({ status: "rejected", code: "source_stock_unavailable" });
    expect(writes(shopify)).toHaveLength(0);
  });

  it("rejects malformed requests before any call", async () => {
    const { shopify, api } = setup();
    for (const bad of [
      request({ quantity: 0 }),
      request({ quantity: 1.5 }),
      request({ arrives_at: "soon" }),
      request({ source_location_external_id: DESTINATION }),
    ]) {
      expect(await api.createTransfer(bad)).toMatchObject({ status: "rejected", code: "invalid_transfer" });
    }
    expect(shopify.requests).toHaveLength(0);
  });

  it("reports a Shopify rejection of the transfer as a clean failure", async () => {
    const { shopify, api } = setup();
    shopify.failNext("ConduitTransferCreate", { code: "INVALID", message: "Location is not active" });
    const result = await api.createTransfer(request());

    expect(result).toMatchObject({ status: "rejected", message: "Location is not active" });
    expect(shopify.transfers).toHaveLength(0);
  });

  it("stays unknown when the transfer response is lost, and reconciles by reading, not writing", async () => {
    const { shopify, api } = setup();
    const req = request();
    shopify.failNext("ConduitTransferCreate", "drop_response");
    const result = await api.createTransfer(req);

    // Shopify created the transfer; Conduit never saw the answer.
    expect(result).toMatchObject({ status: "unknown" });
    expect(shopify.transfers).toHaveLength(1);
    const before = writes(shopify).length;

    const found = await api.findTransfer(req.change_ref);
    expect(found).toMatchObject({ status: "found", state: "reserved", quantity: 40 });
    expect(writes(shopify)).toHaveLength(before);
  });

  it("treats a lost shipment response as unknown, and a replay resolves to the same dispatched transfer", async () => {
    const { shopify, api } = setup();
    const req = request();
    shopify.failNext("ConduitShipmentCreateInTransit", "drop_response");
    const first = await api.createTransfer(req);

    expect(first).toMatchObject({ status: "unknown" });
    expect(await api.findTransfer(req.change_ref)).toMatchObject({ status: "found", state: "in_transit" });

    const replay = await api.createTransfer(req);
    expect(replay).toMatchObject({ status: "applied", state: "in_transit" });
    expect(shopify.transfers).toHaveLength(1);
    expect(shopify.transfers[0].shipments.nodes).toHaveLength(1);
  });

  it("reports reserved stock that was never dispatched as unknown, then resumes dispatch without a second transfer", async () => {
    const { shopify, api } = setup();
    const req = request();
    shopify.failNext("ConduitShipmentCreateInTransit", { code: "INVALID", message: "Shipment rejected" });
    const first = await api.createTransfer(req);

    expect(first).toMatchObject({ status: "unknown" });
    expect(await api.findTransfer(req.change_ref)).toMatchObject({ status: "found", state: "reserved" });
    expect(shopify.level(ITEM, SOURCE)).toMatchObject({ on_hand: 100, available: 60 });

    const resumed = await api.createTransfer(req);
    expect(resumed).toMatchObject({ status: "applied", state: "in_transit" });
    expect(shopify.transfers).toHaveLength(1);
    expect(shopify.requests.filter((r) => r.operationName === "ConduitTransferCreate")).toHaveLength(1);
    expect(shopify.level(ITEM, SOURCE)).toMatchObject({ on_hand: 60, available: 60 });
  });

  it("finds a transfer by its provider reference without scanning every transfer", async () => {
    const { shopify, api } = setup();
    const req = request();
    const applied = await api.createTransfer(req);
    if (applied.status !== "applied") throw new Error("expected applied");
    shopify.requests.length = 0;

    expect(await api.findTransfer(req.change_ref, applied.provider_ref)).toMatchObject({ status: "found", state: "in_transit" });
    expect(shopify.requests.map((r) => r.operationName)).toEqual(["ConduitTransfer"]);
  });

  it("returns not_found for a change reference Conduit never wrote", async () => {
    const { api } = setup();
    expect(await api.findTransfer("never-written")).toEqual({ status: "not_found" });
  });

  it("reads receiving back from the shipment without Conduit receiving anything", async () => {
    const { shopify, api } = setup();
    const req = request();
    const applied = await api.createTransfer(req);
    if (applied.status !== "applied") throw new Error("expected applied");

    shopify.receiveInTransit(applied.transfer_external_id, 15);
    expect(await api.findTransfer(req.change_ref)).toMatchObject({ state: "partially_received", received_qty: 15 });
    shopify.receiveInTransit(applied.transfer_external_id, 40);
    expect(await api.findTransfer(req.change_ref)).toMatchObject({ state: "received", received_qty: 40 });
  });

  it("maps a cancelled transfer to cancelled", async () => {
    const { shopify, api } = setup();
    const req = request();
    shopify.failNext("ConduitShipmentCreateInTransit", { code: "INVALID", message: "nope" });
    await api.createTransfer(req);
    shopify.transfers[0].status = "CANCELED";

    expect(await api.findTransfer(req.change_ref)).toMatchObject({ status: "found", state: "cancelled" });
  });

  it("ignores other internal transfers and supplier transfers when reconciling", async () => {
    const { shopify, api } = setup();
    shopify.addTransfer({ quantity: 5, originLocationId: SOURCE });
    shopify.addTransfer({ quantity: 5 });
    expect(await api.findTransfer(request().change_ref)).toEqual({ status: "not_found" });
  });
});
