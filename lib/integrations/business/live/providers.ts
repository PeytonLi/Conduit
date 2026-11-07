import { registerErpProvider } from "./registry";
import { shopifyProvider } from "./shopify";
import type { ErpProviderDefinition } from "./types";

// Provider lanes add their definition here, e.g.
// import { odooProvider } from "./odoo";
export const builtInErpProviders: ErpProviderDefinition[] = [shopifyProvider];

let registered = false;

export function ensureErpProviders(): void {
  if (registered) return;
  registered = true;
  for (const definition of builtInErpProviders) registerErpProvider(definition);
}
