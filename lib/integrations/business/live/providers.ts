import { quickbooksProvider } from "./quickbooks";
import { registerErpProvider } from "./registry";
import type { ErpProviderDefinition } from "./types";

// Provider lanes add their definition here, e.g.
// import { odooProvider } from "./odoo";
export const builtInErpProviders: ErpProviderDefinition[] = [quickbooksProvider];

let registered = false;

export function ensureErpProviders(): void {
  if (registered) return;
  registered = true;
  for (const definition of builtInErpProviders) registerErpProvider(definition);
}
