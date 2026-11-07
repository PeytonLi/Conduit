/**
 * REAL Intuit sandbox run of the AT-37 contract. Skipped unless QBO_LIVE_CONTRACT=1 plus
 * QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_SANDBOX_REALM_ID and QBO_SANDBOX_REFRESH_TOKEN are set.
 * It always uses the sandbox base URL and creates its own POs and bills in that sandbox company.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { describeErpClientContract } from "@/lib/integrations/business/live/contract";
import { quickbooksProvider } from "@/lib/integrations/business/live/quickbooks";
import { createQboHttp } from "@/lib/integrations/business/live/quickbooks/http";
import { qboCredentialsSchema, type QboCredentials } from "@/lib/integrations/business/live/quickbooks/schemas";

const env = process.env;
const enabled =
  env.QBO_LIVE_CONTRACT === "1" &&
  Boolean(env.QBO_CLIENT_ID && env.QBO_CLIENT_SECRET && env.QBO_SANDBOX_REALM_ID && env.QBO_SANDBOX_REFRESH_TOKEN);
const tokenFile = env.QBO_SANDBOX_TOKEN_FILE ?? join(homedir(), ".conduit-qbo-sandbox.json");

function loadCredentials(): QboCredentials {
  if (existsSync(tokenFile)) {
    const saved = qboCredentialsSchema.parse(JSON.parse(readFileSync(tokenFile, "utf8")));
    if (saved.realm_id === env.QBO_SANDBOX_REALM_ID) return saved;
  }
  return {
    provider: "quickbooks",
    realm_id: env.QBO_SANDBOX_REALM_ID!,
    environment: "sandbox",
    refresh_token: env.QBO_SANDBOX_REFRESH_TOKEN!,
    refresh_token_expires_at: null,
    access_token: null,
    access_token_expires_at: null,
  };
}

let credentials: QboCredentials | null = null;
/** Intuit rotates refresh tokens, so the latest one is kept outside the repo for the next run. */
async function save(next: unknown) {
  credentials = qboCredentialsSchema.parse(next);
  writeFileSync(tokenFile, JSON.stringify(credentials), { mode: 0o600 });
  return "saved" as const;
}

describe.skipIf(!enabled)("QuickBooks ErpClient contract (REAL Intuit sandbox)", () => {
  describeErpClientContract(async () => {
    credentials ??= loadCredentials();
    expect(credentials.environment).toBe("sandbox");
    const deps = { fetch, now: () => new Date(), saveCredentials: save };
    const http = createQboHttp({
      clientId: env.QBO_CLIENT_ID!,
      clientSecret: env.QBO_CLIENT_SECRET!,
      credentials,
      ...deps,
    });
    const [vendor] = await http.query("Vendor", "");
    const item = (await http.query("Item", "Type = 'Inventory'"))[0];
    if (!vendor || !item) throw new Error("The sandbox company needs at least one vendor and one inventory item");
    const po = await http.write(
      "PurchaseOrder",
      {
        VendorRef: { value: vendor.Id },
        POStatus: "Open",
        DueDate: new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10),
        PrivateNote: "Conduit AT-37 contract test PO (sandbox)",
        Line: [
          {
            DetailType: "ItemBasedExpenseLineDetail",
            Amount: 10,
            ItemBasedExpenseLineDetail: { ItemRef: { value: item.Id }, Qty: 10, UnitPrice: 1 },
          },
        ],
      },
      `conduit-at37-seed-${Date.now()}`,
    );
    const lineId = po.Line[0].Id!;
    const client = quickbooksProvider.createClient(http.credentials, deps as never);
    return {
      client,
      poExternalId: po.Id,
      lineExternalId: `${po.Id}:${lineId}`,
      async touch() {
        const current = (await http.read("PurchaseOrder", po.Id))!;
        await http.write("PurchaseOrder", { Id: po.Id, SyncToken: current.SyncToken, sparse: true, Memo: `touched ${Date.now()}` }, `conduit-at37-touch-${Date.now()}`);
      },
      async receive(quantity) {
        await http.write(
          "Bill",
          {
            VendorRef: { value: vendor.Id },
            Line: [
              {
                DetailType: "ItemBasedExpenseLineDetail",
                Amount: quantity,
                ItemBasedExpenseLineDetail: { ItemRef: { value: item.Id }, Qty: quantity, UnitPrice: 1 },
                LinkedTxn: [{ TxnId: po.Id, TxnType: "PurchaseOrder", TxnLineId: lineId }],
              },
            ],
          },
          `conduit-at37-bill-${Date.now()}`,
        );
      },
    };
  });
});
