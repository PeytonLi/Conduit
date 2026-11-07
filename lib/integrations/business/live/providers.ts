import { odooProvider } from "./odoo";
import { quickbooksProvider } from "./quickbooks";
import { registerErpProvider } from "./registry";
import { shopifyProvider } from "./shopify";
import type { ErpProviderDefinition } from "./types";
import { zohoInventoryProvider } from "./zoho";

// Provider lanes add their definition here.
export const builtInErpProviders: ErpProviderDefinition[] = [
  odooProvider,
  quickbooksProvider,
  shopifyProvider,
  zohoInventoryProvider,
];

let registered = false;

export function ensureErpProviders(): void {
  if (registered) return;
  registered = true;
  for (const definition of builtInErpProviders) registerErpProvider(definition);
}
