import { odooProvider } from "./odoo";
import { quickbooksProvider } from "./quickbooks";
import { registerErpProvider } from "./registry";
import type { ErpProviderDefinition } from "./types";

// Provider lanes add their definition here.
export const builtInErpProviders: ErpProviderDefinition[] = [odooProvider, quickbooksProvider];

let registered = false;

export function ensureErpProviders(): void {
  if (registered) return;
  registered = true;
  for (const definition of builtInErpProviders) registerErpProvider(definition);
}
