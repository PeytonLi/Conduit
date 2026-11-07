const DATA_CENTER_TLDS = ["com", "eu", "in", "com.au", "jp", "ca", "com.cn", "sa"] as const;
const TLD = DATA_CENTER_TLDS.map((tld) => tld.replace(".", "\\.")).join("|");
const ACCOUNTS_HOST = new RegExp(`^accounts\\.(?:zoho\\.(${TLD})|zohocloud\\.(ca))$`);
const API_HOST = new RegExp(`^(?:www\\.zohoapis|api\\.zoho)\\.(${TLD})$`);

export const DEFAULT_ZOHO_ACCOUNTS_SERVER = "https://accounts.zoho.com";

function parseHttps(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.port === "" && url.href === `${url.origin}/` ? url : null;
  } catch {
    return null;
  }
}

/** Normalizes an accounts server (e.g. from the OAuth `accounts-server` param) to a known Zoho data center. */
export function zohoAccountsServer(value: string): string | null {
  const url = parseHttps(value);
  if (!url || !ACCOUNTS_HOST.test(url.hostname)) return null;
  return url.origin;
}

/** Maps the token response's `api_domain` to the Inventory v1 base URL for that data center. */
export function zohoInventoryBaseUrl(apiDomain: string): string | null {
  const url = parseHttps(apiDomain);
  const match = url ? API_HOST.exec(url.hostname) : null;
  if (!match) return null;
  return `https://www.zohoapis.${match[1]}/inventory/v1`;
}
