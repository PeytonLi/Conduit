import { z } from "zod";
import { erpProviderLabels } from "./registry";
import type { ErpProvider } from "./types";

const optional = z.string().trim().optional();
const gateEnvSchema = z.object({
  CREDENTIAL_ENCRYPTION_KEY: optional,
  ZOHO_CLIENT_ID: optional,
  QBO_CLIENT_ID: optional,
  SHOPIFY_CLIENT_ID: optional,
});

export type BusinessConnectMethod = "odoo_form" | "oauth" | "shopify_shop";

export interface BusinessSystemOption {
  provider: ErpProvider;
  label: string;
  method: BusinessConnectMethod;
  connectPath: string;
}

const options: (BusinessSystemOption & { gate: keyof z.infer<typeof gateEnvSchema> | null })[] = [
  { provider: "odoo", label: erpProviderLabels.odoo, method: "odoo_form", connectPath: "/api/auth/odoo/connect", gate: null },
  {
    provider: "zoho_inventory",
    label: erpProviderLabels.zoho_inventory,
    method: "oauth",
    connectPath: "/api/auth/zoho/connect",
    gate: "ZOHO_CLIENT_ID",
  },
  {
    provider: "quickbooks",
    label: erpProviderLabels.quickbooks,
    method: "oauth",
    connectPath: "/api/auth/quickbooks/connect",
    gate: "QBO_CLIENT_ID",
  },
  {
    provider: "shopify",
    label: erpProviderLabels.shopify,
    method: "shopify_shop",
    connectPath: "/api/auth/shopify/connect",
    gate: "SHOPIFY_CLIENT_ID",
  },
];

/** Business systems this deployment can connect; providers without their app credentials are hidden. */
export function availableBusinessSystems(env: Record<string, string | undefined>): BusinessSystemOption[] {
  const parsed = gateEnvSchema.parse(env);
  if (!parsed.CREDENTIAL_ENCRYPTION_KEY) return [];
  return options
    .filter((o) => o.gate === null || Boolean(parsed[o.gate]))
    .map((o) => ({ provider: o.provider, label: o.label, method: o.method, connectPath: o.connectPath }));
}
