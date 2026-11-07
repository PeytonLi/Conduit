import { randomUUID } from "node:crypto";
import { describe } from "vitest";
import { z } from "zod";
import { describeErpClientContract } from "@/lib/integrations/business/live/contract";
import { shopifyProvider } from "@/lib/integrations/business/live/shopify";
import { createShopifyGraphql, isShopDomain } from "@/lib/integrations/business/live/shopify/graphql";

/**
 * Real-system run against a Shopify development store. Skipped unless SHOPIFY_LIVE_TEST=1. Creates
 * tagged transfers on SHOPIFY_LIVE_SHOP, so it must only point at a dev store that was audited first,
 * and SHOPIFY_LIVE_CONFIRM_DEV_STORE must repeat that shop domain. The token needs the connector
 * scopes plus write_inventory_transfers and write_inventory_shipments_received_items for fixtures.
 */
const env = process.env;
const enabled =
  env.SHOPIFY_LIVE_TEST === "1" &&
  isShopDomain(env.SHOPIFY_LIVE_SHOP) &&
  env.SHOPIFY_LIVE_CONFIRM_DEV_STORE === env.SHOPIFY_LIVE_SHOP &&
  !!env.SHOPIFY_LIVE_ACCESS_TOKEN &&
  !!env.SHOPIFY_LIVE_LOCATION_ID &&
  !!env.SHOPIFY_LIVE_INVENTORY_ITEM_ID;

const payload = z.record(z.string(), z.object({ userErrors: z.array(z.object({ message: z.string() })) }).passthrough());

describe.skipIf(!enabled)("Shopify ErpClient contract (real development store)", () => {
  const shop = env.SHOPIFY_LIVE_SHOP!;
  const token = env.SHOPIFY_LIVE_ACCESS_TOKEN!;
  const itemId = env.SHOPIFY_LIVE_INVENTORY_ITEM_ID!;

  async function mutate(name: string, query: string, variables: Record<string, unknown>) {
    const graphql = createShopifyGraphql({ shop, accessToken: token });
    const data = await graphql(name, query, { ...variables, idempotencyKey: randomUUID() }, payload);
    const errors = Object.values(data).flatMap((p) => p.userErrors);
    if (errors.length) throw new Error(`${name}: ${errors.map((e) => e.message).join("; ")}`);
    return data;
  }

  describeErpClientContract(async () => {
    const created = await mutate(
      "ConduitTestTransfer",
      `mutation ConduitTestTransfer($input: InventoryTransferCreateAsReadyToShipInput!, $idempotencyKey: String!) {
        inventoryTransferCreateAsReadyToShip(input: $input) @idempotent(key: $idempotencyKey) {
          inventoryTransfer { id lineItems(first: 1) { nodes { id } } } userErrors { message }
        }
      }`,
      {
        input: {
          destinationLocationId: env.SHOPIFY_LIVE_LOCATION_ID,
          lineItems: [{ inventoryItemId: itemId, quantity: 10 }],
          note: "Conduit contract test",
          tags: ["conduit-contract-test"],
        },
      },
    );
    const transfer = (created.inventoryTransferCreateAsReadyToShip as unknown as {
      inventoryTransfer: { id: string; lineItems: { nodes: Array<{ id: string }> } };
    }).inventoryTransfer;
    let total = 10;

    return {
      client: shopifyProvider.createClient({
        shop,
        access_token: token,
        scope: "",
        access_token_expires_at: null,
        refresh_token: null,
        refresh_token_expires_at: null,
      }),
      poExternalId: transfer.id,
      lineExternalId: transfer.lineItems.nodes[0].id,
      touch: async () => {
        total += 1;
        await mutate(
          "ConduitTestTouch",
          `mutation ConduitTestTouch($input: InventoryTransferSetItemsInput!, $idempotencyKey: String!) {
            inventoryTransferSetItems(input: $input) @idempotent(key: $idempotencyKey) { userErrors { message } }
          }`,
          { input: { id: transfer.id, lineItems: [{ inventoryItemId: itemId, quantity: total }] } },
        );
      },
      receive: async (quantity) => {
        const shipped = await mutate(
          "ConduitTestShip",
          `mutation ConduitTestShip($input: InventoryShipmentCreateInput!, $idempotencyKey: String!) {
            inventoryShipmentCreateInTransit(input: $input) @idempotent(key: $idempotencyKey) {
              inventoryShipment { id lineItems(first: 1) { nodes { id } } } userErrors { message }
            }
          }`,
          { input: { movementId: transfer.id, lineItems: [{ inventoryItemId: itemId, quantity }] } },
        );
        const shipment = (shipped.inventoryShipmentCreateInTransit as unknown as {
          inventoryShipment: { id: string; lineItems: { nodes: Array<{ id: string }> } };
        }).inventoryShipment;
        await mutate(
          "ConduitTestReceive",
          `mutation ConduitTestReceive($id: ID!, $lineItems: [InventoryShipmentReceiveItemInput!], $idempotencyKey: String!) {
            inventoryShipmentReceive(id: $id, lineItems: $lineItems) @idempotent(key: $idempotencyKey) { userErrors { message } }
          }`,
          { id: shipment.id, lineItems: [{ shipmentLineItemId: shipment.lineItems.nodes[0].id, quantity, reason: "ACCEPTED" }] },
        );
      },
    };
  });
});
