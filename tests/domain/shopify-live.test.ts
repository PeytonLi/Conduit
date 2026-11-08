/**
 * REAL Shopify development-store run of the AT-37 contract. Skipped unless SHOPIFY_LIVE_TEST is set.
 *
 *   SHOPIFY_LIVE_TEST=preflight   reads only: shows which shop, location and item a contract run would use.
 *   SHOPIFY_LIVE_TEST=1           runs the contract, which creates its own tagged transfers and shipments.
 *
 * Required for either mode:
 *   SHOPIFY_LIVE_SHOP                 the dev store, e.g. conduit-dev.myshopify.com
 *   SHOPIFY_LIVE_CONFIRM_DEV_STORE    must repeat SHOPIFY_LIVE_SHOP exactly (so a stale shop value cannot run)
 *   SHOPIFY_LIVE_LOCATION_ID          gid of the store location the seeded transfers deliver to
 *   SHOPIFY_LIVE_INVENTORY_ITEM_ID    gid of a tracked inventory item used on the seeded transfers
 *   plus one credential source:
 *     SHOPIFY_LIVE_ACCESS_TOKEN                          a token that stays valid for the run, or
 *     SHOPIFY_LIVE_REFRESH_TOKEN + SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET   an expiring offline token
 *                                                        (rotated pairs are kept in SHOPIFY_LIVE_TOKEN_FILE)
 *
 * Every request goes to https://<SHOPIFY_LIVE_SHOP>, a token only works on its own shop, and the run
 * first reads the shop back and refuses to write unless it is the declared one and a development store.
 * The token needs the connector scopes plus write_inventory_transfers and
 * write_inventory_shipments_received_items for the fixtures.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { describeErpClientContract, type ContractFixture } from "@/lib/integrations/business/live/contract";
import { createShopifyErpClient } from "@/lib/integrations/business/live/shopify/client";
import { isShopDomain } from "@/lib/integrations/business/live/shopify/graphql";
import { createRefreshingShopifyGraphql } from "@/lib/integrations/business/live/shopify";
import { shopifyCredentialsSchema, type ShopifyCredentials } from "@/lib/integrations/business/live/shopify/oauth";

const env = process.env;
const shop = env.SHOPIFY_LIVE_SHOP ?? "";
const locationId = env.SHOPIFY_LIVE_LOCATION_ID ?? "";
const itemId = env.SHOPIFY_LIVE_INVENTORY_ITEM_ID ?? "";
const rotating = Boolean(env.SHOPIFY_LIVE_REFRESH_TOKEN && env.SHOPIFY_CLIENT_ID && env.SHOPIFY_CLIENT_SECRET);
const configured =
  isShopDomain(shop) &&
  env.SHOPIFY_LIVE_CONFIRM_DEV_STORE === shop &&
  Boolean(locationId && itemId) &&
  (rotating || Boolean(env.SHOPIFY_LIVE_ACCESS_TOKEN));
const mode = configured ? env.SHOPIFY_LIVE_TEST : undefined;
const tokenFile = env.SHOPIFY_LIVE_TOKEN_FILE ?? join(homedir(), ".conduit-shopify-live.json");

if (mode === "1") vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const longAgo = "2000-01-01T00:00:00.000Z";

function loadCredentials(): ShopifyCredentials {
  if (rotating) {
    if (existsSync(tokenFile)) {
      const saved = shopifyCredentialsSchema.parse(JSON.parse(readFileSync(tokenFile, "utf8")));
      if (saved.shop === shop) return saved;
    }
    return {
      shop,
      access_token: "expired-placeholder",
      scope: "",
      access_token_expires_at: longAgo,
      refresh_token: env.SHOPIFY_LIVE_REFRESH_TOKEN!,
      refresh_token_expires_at: null,
    };
  }
  return { shop, access_token: env.SHOPIFY_LIVE_ACCESS_TOKEN!, scope: "", access_token_expires_at: null, refresh_token: null, refresh_token_expires_at: null };
}

let current: ShopifyCredentials | null = null;
/** Shopify rotates the refresh token on every refresh, so the newest pair is kept outside the repo. */
async function save(next: unknown) {
  current = shopifyCredentialsSchema.parse(next);
  if (rotating) writeFileSync(tokenFile, JSON.stringify(current), { mode: 0o600 });
}

/** Lets one test swap the transport (for example, to drop a response) without a second token refresher. */
let transport: typeof fetch = (input, init) => fetch(input, init);
const sharedFetch: typeof fetch = (input, init) => transport(input, init);

function newGraphql(credentials: ShopifyCredentials) {
  return createRefreshingShopifyGraphql({ credentials, fetch: sharedFetch, saveCredentials: save });
}

/** One refresher at a time per shop: concurrent refreshers would retire each other's refresh tokens. */
let shared: ReturnType<typeof newGraphql> | null = null;
function graphql() {
  current ??= loadCredentials();
  shared ??= newGraphql(current);
  return shared;
}

const userErrors = z.array(z.object({ message: z.string() }));
const preflightSchema = z.object({
  shop: z.object({
    myshopifyDomain: z.string(),
    name: z.string(),
    currencyCode: z.string(),
    plan: z.object({ partnerDevelopment: z.boolean(), displayName: z.string() }),
  }),
  location: z.object({ id: z.string(), name: z.string(), isActive: z.boolean() }).nullable(),
  inventoryItem: z.object({ id: z.string(), sku: z.string().nullable(), tracked: z.boolean() }).nullable(),
});
const PREFLIGHT_QUERY = `query ConduitLivePreflight($location: ID!, $item: ID!) {
  shop { myshopifyDomain name currencyCode plan { partnerDevelopment displayName } }
  location(id: $location) { id name isActive }
  inventoryItem(id: $item) { id sku tracked }
}`;

async function readTarget() {
  return graphql()("ConduitLivePreflight", PREFLIGHT_QUERY, { location: locationId, item: itemId }, preflightSchema);
}

let verified: Promise<void> | null = null;
/** Memoized gate in front of every write: the API must report the declared dev store, location and item. */
function assertDeclaredShop(): Promise<void> {
  verified ??= (async () => {
    const target = await readTarget();
    expect(target.shop.myshopifyDomain.toLowerCase()).toBe(shop.toLowerCase());
    if (!target.shop.plan.partnerDevelopment && env.SHOPIFY_LIVE_ALLOW_NON_DEV_PLAN !== "1") {
      throw new Error(`${shop} is on the "${target.shop.plan.displayName}" plan, not a development store; refusing to write`);
    }
    expect(target.location?.isActive, "SHOPIFY_LIVE_LOCATION_ID must be an active location of the shop").toBe(true);
    expect(target.inventoryItem?.tracked, "SHOPIFY_LIVE_INVENTORY_ITEM_ID must be a tracked item of the shop").toBe(true);
  })();
  return verified;
}

async function mutate<T extends Record<string, { userErrors: Array<{ message: string }> }>>(
  name: string,
  query: string,
  variables: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  await assertDeclaredShop();
  const data = await graphql()(name, query, { ...variables, idempotencyKey: randomUUID() }, schema);
  const errors = Object.values(data).flatMap((p) => p.userErrors);
  if (errors.length) throw new Error(`${name}: ${errors.map((e) => e.message).join("; ")}`);
  return data;
}

const idNodes = z.object({ nodes: z.array(z.object({ id: z.string() })) });
const createdTransfer = z.object({
  inventoryTransferCreateAsReadyToShip: z.object({
    inventoryTransfer: z.object({ id: z.string(), lineItems: idNodes }),
    userErrors,
  }),
});
const touched = z.object({ inventoryTransferSetItems: z.object({ userErrors }) });
const shippedSchema = z.object({
  inventoryShipmentCreateInTransit: z.object({ inventoryShipment: z.object({ id: z.string(), lineItems: idNodes }), userErrors }),
});
const receivedSchema = z.object({ inventoryShipmentReceive: z.object({ userErrors }) });
const canceledSchema = z.object({ inventoryTransferCancel: z.object({ userErrors }) });

const seededTransfers: string[] = [];

/** Creates a tagged supplier-style transfer (no origin location) for 10 units of the declared item. */
async function seedTransfer() {
  const created = await mutate(
    "ConduitTestTransfer",
    `mutation ConduitTestTransfer($input: InventoryTransferCreateAsReadyToShipInput!, $idempotencyKey: String!) {
      inventoryTransferCreateAsReadyToShip(input: $input) @idempotent(key: $idempotencyKey) {
        inventoryTransfer { id lineItems(first: 1) { nodes { id } } } userErrors { message }
      }
    }`,
    {
      input: {
        destinationLocationId: locationId,
        lineItems: [{ inventoryItemId: itemId, quantity: 10 }],
        note: "Conduit contract test",
        tags: ["conduit-contract-test"],
      },
    },
    createdTransfer,
  );
  const transfer = created.inventoryTransferCreateAsReadyToShip.inventoryTransfer;
  seededTransfers.push(transfer.id);
  let total = 10;

  return {
    poExternalId: transfer.id,
    lineExternalId: transfer.lineItems.nodes[0].id,
    /** Changes the transfer in Shopify directly so its version moves. */
    async touch() {
      total += 1;
      await mutate(
        "ConduitTestTouch",
        `mutation ConduitTestTouch($input: InventoryTransferSetItemsInput!, $idempotencyKey: String!) {
          inventoryTransferSetItems(input: $input) @idempotent(key: $idempotencyKey) { userErrors { message } }
        }`,
        { input: { id: transfer.id, lineItems: [{ inventoryItemId: itemId, quantity: total }] } },
        touched,
      );
    },
    /** Ships and receives `quantity` units outside Conduit, the way a warehouse would. */
    async receive(quantity: number) {
      const shipped = await mutate(
        "ConduitTestShip",
        `mutation ConduitTestShip($input: InventoryShipmentCreateInput!, $idempotencyKey: String!) {
          inventoryShipmentCreateInTransit(input: $input) @idempotent(key: $idempotencyKey) {
            inventoryShipment { id lineItems(first: 1) { nodes { id } } } userErrors { message }
          }
        }`,
        { input: { movementId: transfer.id, lineItems: [{ inventoryItemId: itemId, quantity }] } },
        shippedSchema,
      );
      const shipment = shipped.inventoryShipmentCreateInTransit.inventoryShipment;
      await mutate(
        "ConduitTestReceive",
        `mutation ConduitTestReceive($id: ID!, $lineItems: [InventoryShipmentReceiveItemInput!], $idempotencyKey: String!) {
          inventoryShipmentReceive(id: $id, lineItems: $lineItems) @idempotent(key: $idempotencyKey) { userErrors { message } }
        }`,
        { id: shipment.id, lineItems: [{ shipmentLineItemId: shipment.lineItems.nodes[0].id, quantity, reason: "ACCEPTED" }] },
        receivedSchema,
      );
    },
  };
}

async function seedFixture(): Promise<ContractFixture> {
  const seeded = await seedTransfer();
  return { client: createShopifyErpClient({ graphql: graphql() }), ...seeded };
}

const day = (offset: number) => new Date(Date.UTC(2030, 0, 10 + offset, 17)).toISOString();

describe.skipIf(mode !== "preflight")("Shopify preflight (REAL development store, read-only)", () => {
  it("shows which shop the contract run would write to", async () => {
    const target = await readTarget();
    console.info(
      JSON.stringify({
        shop: target.shop.myshopifyDomain,
        name: target.shop.name,
        plan: target.shop.plan.displayName,
        development_store: target.shop.plan.partnerDevelopment,
        location: target.location,
        item: target.inventoryItem,
      }),
    );
    expect(target.shop.myshopifyDomain.toLowerCase()).toBe(shop.toLowerCase());
    expect(target.location).not.toBeNull();
    expect(target.inventoryItem).not.toBeNull();
  });
});

describe.skipIf(mode !== "1")("Shopify ErpClient contract (REAL development store)", () => {
  afterAll(async () => {
    // Best effort: leave the dev store tidy. A transfer that already has shipments may refuse to cancel.
    for (const id of seededTransfers) {
      try {
        await mutate(
          "ConduitTestCancel",
          `mutation ConduitTestCancel($id: ID!, $idempotencyKey: String!) {
            inventoryTransferCancel(id: $id) @idempotent(key: $idempotencyKey) { userErrors { message } }
          }`,
          { id },
          canceledSchema,
        );
      } catch (err) {
        console.info(`Left test transfer ${id} in place: ${(err as Error).message}`);
      }
    }
  });

  it("only writes after the API confirms the declared development store", async () => {
    await assertDeclaredShop();
  });

  it.skipIf(!rotating)("rotates the refresh token and stores the new pair before it is used again", async () => {
    await assertDeclaredShop();
    shared = null;
    const before = current ?? loadCredentials();
    const stored: ShopifyCredentials[] = [];
    const rotated = createRefreshingShopifyGraphql({
      credentials: { ...before, access_token_expires_at: longAgo },
      fetch: sharedFetch,
      saveCredentials: async (next) => {
        await save(next);
        stored.push(shopifyCredentialsSchema.parse(next));
      },
    });
    await rotated("ConduitLivePreflight", PREFLIGHT_QUERY, { location: locationId, item: itemId }, preflightSchema);

    expect(stored).toHaveLength(1);
    expect(stored[0].refresh_token).toBeTruthy();
    expect(stored[0].refresh_token).not.toBe(before.refresh_token);
    expect(shopifyCredentialsSchema.parse(JSON.parse(readFileSync(tokenFile, "utf8"))).refresh_token).toBe(stored[0].refresh_token);

    // The stored pair, loaded cold, works without another refresh.
    const resumed = newGraphql(loadCredentials());
    const again = await resumed("ConduitLivePreflight", PREFLIGHT_QUERY, { location: locationId, item: itemId }, preflightSchema);
    expect(again.shop.myshopifyDomain.toLowerCase()).toBe(shop.toLowerCase());
    shared = null;
  });

  describeErpClientContract(seedFixture);

  describe("Shopify specifics", () => {
    it("reads the declared location and item, and a stable version when nothing changed", async () => {
      const f = await seedFixture();
      const snapshot = await f.client.readSnapshot();
      expect(snapshot.locations.some((l) => l.external_id === locationId)).toBe(true);
      expect(snapshot.items.some((i) => i.external_id === itemId)).toBe(true);
      const a = await f.client.readPurchaseOrder(f.poExternalId);
      const b = await f.client.readPurchaseOrder(f.poExternalId);
      expect(a?.version).toBeTruthy();
      expect(a?.version).toBe(b?.version);
      expect(a?.status).toBe("ready_to_ship");
    });

    it("changes the version when the transfer changes outside Conduit", async () => {
      const f = await seedFixture();
      const before = await f.client.readPurchaseOrder(f.poExternalId);
      await f.touch();
      const after = await f.client.readPurchaseOrder(f.poExternalId);
      expect(after?.version).not.toBe(before?.version);
    });

    it("rejects an invalid split without writing anything", async () => {
      const f = await seedFixture();
      const po = (await f.client.readPurchaseOrder(f.poExternalId))!;
      const base = { po_external_id: f.poExternalId, line_external_id: f.lineExternalId, expected_version: po.version };
      const short = await f.client.applyDeliverySplit({
        ...base,
        change_ref: `contract-short-${Date.now()}`,
        schedules: [{ quantity: 3, earliest_at: day(1), latest_at: day(1) }],
      });
      expect(short).toMatchObject({ status: "rejected", code: "quantity_mismatch" });
      const after = await f.client.readPurchaseOrder(f.poExternalId);
      expect(after?.version).toBe(po.version);
    });

    it("reconciles a split whose shipment response was lost, without duplicating the shipment", async () => {
      const f = await seedFixture();
      const po = (await f.client.readPurchaseOrder(f.poExternalId))!;
      const line = po.lines.find((l) => l.external_line_id === f.lineExternalId)!;
      const open = line.ordered_qty - line.received_qty;
      const first = Math.floor(open / 2);
      const request = {
        change_ref: `contract-lost-${Date.now()}`,
        po_external_id: f.poExternalId,
        line_external_id: f.lineExternalId,
        expected_version: po.version,
        schedules: [
          { quantity: first, earliest_at: day(1), latest_at: day(1) },
          { quantity: open - first, earliest_at: day(3), latest_at: day(3) },
        ],
      };

      // Shopify performs the first shipment create; the response never reaches Conduit.
      let dropped = false;
      transport = async (input, init) => {
        const response = await fetch(input, init);
        if (!dropped && String(init?.body).includes('"operationName":"ConduitShipmentCreate"')) {
          dropped = true;
          await response.text();
          throw new TypeError("simulated lost response");
        }
        return response;
      };
      let lost;
      try {
        lost = await f.client.applyDeliverySplit(request);
      } finally {
        transport = (input, init) => fetch(input, init);
      }
      expect(dropped).toBe(true);
      expect(lost.status).toBe("unknown");

      // One of two shipments exists, so the change is not complete and is not reported as applied.
      expect((await f.client.findChange(request.change_ref, f.poExternalId)).status).not.toBe("applied");

      // The retry reuses the same change reference, skips the shipment that exists, and completes the rest.
      const retried = await f.client.applyDeliverySplit(request);
      expect(retried.status).toBe("applied");
      if (retried.status !== "applied") return;
      expect(retried.deliveries.map((d) => d.quantity).sort((a, b) => a - b)).toEqual([first, open - first].sort((a, b) => a - b));
      const found = await f.client.findChange(request.change_ref, f.poExternalId);
      expect(found.status).toBe("applied");
      if (found.status === "applied") expect(found.deliveries).toHaveLength(2);
    });

    it("refuses to reuse a change reference for a different split", async () => {
      const f = await seedFixture();
      const po = (await f.client.readPurchaseOrder(f.poExternalId))!;
      const change_ref = `contract-reuse-${Date.now()}`;
      const base = { change_ref, po_external_id: f.poExternalId, line_external_id: f.lineExternalId };
      const applied = await f.client.applyDeliverySplit({
        ...base,
        expected_version: po.version,
        schedules: [
          { quantity: 4, earliest_at: day(1), latest_at: day(1) },
          { quantity: 6, earliest_at: day(2), latest_at: day(2) },
        ],
      });
      expect(applied.status).toBe("applied");
      if (applied.status !== "applied") return;
      const reused = await f.client.applyDeliverySplit({
        ...base,
        expected_version: applied.version,
        schedules: [
          { quantity: 2, earliest_at: day(1), latest_at: day(1) },
          { quantity: 3, earliest_at: day(2), latest_at: day(2) },
          { quantity: 5, earliest_at: day(3), latest_at: day(3) },
        ],
      });
      expect(reused).toMatchObject({ status: "rejected", code: "change_ref_reused" });
    });
  });
});
