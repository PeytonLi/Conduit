import type { ErpProvider, ErpProviderDefinition } from "./types";

export type { ErpProvider };

export const erpProviders: readonly ErpProvider[] = ["odoo", "zoho_inventory", "quickbooks", "shopify"];

export const erpProviderLabels: Record<ErpProvider, string> = {
  odoo: "Odoo",
  zoho_inventory: "Zoho Inventory",
  quickbooks: "QuickBooks Online",
  shopify: "Shopify",
};

export function isErpProvider(value: unknown): value is ErpProvider {
  return typeof value === "string" && (erpProviders as readonly string[]).includes(value);
}

const definitions = new Map<ErpProvider, ErpProviderDefinition>();

export function registerErpProvider(definition: ErpProviderDefinition): void {
  definitions.set(definition.provider, definition);
}

export function getErpProviderDefinition(provider: ErpProvider): ErpProviderDefinition | null {
  return definitions.get(provider) ?? null;
}

/** Test-only: forget every registered definition. */
export function resetErpProvidersForTest(): void {
  definitions.clear();
}
