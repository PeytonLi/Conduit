import { quickbooksProvider } from "./quickbooks";
import { registerErpProvider } from "./registry";
import { shopifyProvider } from "./shopify";
import type { ErpProviderDefinition } from "./types";
import { zohoInventoryProvider } from "./zoho";

// Provider lanes add their definition here, e.g.
// import { odooProvider } from "./odoo";
export const builtInErpProviders: ErpProviderDefinition[] = [quickbooksProvider, shopifyProvider, zohoInventoryProvider];

let registered = false;

export function ensureErpProviders(): void {
  if (registered) return;
  registered = true;
  for (const definition of builtInErpProviders) registerErpProvider(definition);
}
