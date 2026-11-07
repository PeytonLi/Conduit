import { odooProvider } from "./odoo";
import { registerErpProvider } from "./registry";
import type { ErpProviderDefinition } from "./types";

// Provider lanes add their definition here.
export const builtInErpProviders: ErpProviderDefinition[] = [odooProvider];

let registered = false;

export function ensureErpProviders(): void {
  if (registered) return;
  registered = true;
  for (const definition of builtInErpProviders) registerErpProvider(definition);
}
