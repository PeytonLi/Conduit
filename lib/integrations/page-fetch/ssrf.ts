import { isIP } from "node:net";

/**
 * Pure SSRF guards for the optional direct page fetcher (docs/prd/04 §
 * "Public URL discovery"). Nothing here performs I/O.
 */

export type BlockReason =
  | "invalid_url"
  | "unsafe_scheme"
  | "credentials_in_url"
  | "blocked_port"
  | "blocked_host"
  | "blocked_address"
  | "not_allowlisted";

export class UrlRejection extends Error {
  readonly reason: BlockReason;

  constructor(reason: BlockReason, message: string) {
    super(message);
    this.name = "UrlRejection";
    this.reason = reason;
  }
}

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);
const ALLOWED_PORTS = new Set(["", "80", "443"]);
const MAX_URL_LENGTH = 2048;

/** Hostname suffixes that never resolve to the public internet. */
const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".localdomain",
  ".lan",
  ".home",
  ".home.arpa",
  ".intranet",
  ".corp",
  ".private",
  ".test",
  ".invalid",
  ".example",
  ".in-addr.arpa",
  ".ip6.arpa",
];

// ---------------------------------------------------------------------------
// IP classification
// ---------------------------------------------------------------------------

type Cidr4 = readonly [string, number];

/** IANA IPv4 special-purpose ranges that must never be fetched. */
const BLOCKED_V4: readonly Cidr4[] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // RFC1918
  ["100.64.0.0", 10], // CGNAT (also Alibaba metadata 100.100.100.200)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local incl. cloud metadata 169.254.169.254
  ["172.16.0.0", 12], // RFC1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // deprecated 6to4 relay
  ["192.168.0.0", 16], // RFC1918
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
];

function parseIPv4(text: string): number | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

function inCidr4(value: number, [base, bits]: Cidr4): boolean {
  const baseValue = parseIPv4(base) as number;
  const size = 2 ** (32 - bits);
  return Math.floor(value / size) === Math.floor(baseValue / size);
}

/** Returns eight 16-bit groups, or null when `text` is not a valid IPv6 literal. */
function parseIPv6(input: string): number[] | null {
  let text = input;
  if (text.includes("%")) return null; // zone ids are never legitimate here
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  if (lastColon !== -1 && text.slice(lastColon + 1).includes(".")) {
    const v4 = parseIPv4(text.slice(lastColon + 1));
    if (v4 === null) return null;
    tail = [Math.floor(v4 / 65536), v4 % 65536];
    text = `${text.slice(0, lastColon + 1)}0:0`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (chunk: string): number[] | null => {
    if (chunk === "") return [];
    const groups: number[] = [];
    for (const g of chunk.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      groups.push(parseInt(g, 16));
    }
    return groups;
  };
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  if (head === null || rest === null) return null;
  let groups: number[];
  if (halves.length === 2) {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array<number>(missing).fill(0), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  if (tail.length === 2) {
    groups[6] = tail[0];
    groups[7] = tail[1];
  }
  return groups;
}

function v4FromGroups(hi: number, lo: number): number {
  return hi * 65536 + lo;
}

function isBlockedV4Value(value: number): boolean {
  return BLOCKED_V4.some((cidr) => inCidr4(value, cidr));
}

function isBlockedV6(g: number[]): boolean {
  // Embedded-IPv4 forms are judged by the IPv4 address they carry.
  const firstFiveZero = g.slice(0, 5).every((x) => x === 0);
  if (firstFiveZero && g[5] === 0xffff) {
    return isBlockedV4Value(v4FromGroups(g[6], g[7])); // ::ffff:a.b.c.d
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return isBlockedV4Value(v4FromGroups(g[6], g[7])); // 64:ff9b::/96 NAT64
  }
  if (g[0] === 0x2002) {
    return isBlockedV4Value(v4FromGroups(g[1], g[2])); // 6to4
  }
  // Only global unicast 2000::/3 is eligible; everything else (loopback,
  // unspecified, ULA fc00::/7 incl. fd00:ec2::254, link-local fe80::/10,
  // site-local, multicast, discard, v4-compatible ::/96, ...) is blocked.
  if ((g[0] & 0xe000) !== 0x2000) return true;
  if (g[0] === 0x2001 && g[1] < 0x200) return true; // 2001::/23 (Teredo, ORCHID, ...)
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x3fff && g[1] < 0x1000) return true; // 3fff::/20 documentation
  return false;
}

/**
 * True when `address` is an IP literal that is NOT a plain public unicast
 * address. Non-IP input and malformed literals count as blocked (fail closed).
 */
export function isBlockedAddress(address: string): boolean {
  const bare = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  const family = isIP(bare);
  if (family === 4) {
    const value = parseIPv4(bare);
    return value === null ? true : isBlockedV4Value(value);
  }
  if (family === 6) {
    const groups = parseIPv6(bare);
    return groups === null ? true : isBlockedV6(groups);
  }
  return true;
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

export interface ValidatedUrl {
  url: URL;
  /** Lowercased hostname without brackets or trailing dot. */
  hostname: string;
  /** Set when the host is an IP literal (already known to be public). */
  ipLiteral: { address: string; family: 4 | 6 } | null;
}

/** Parses the allowlist env value: comma/whitespace separated, lowercased. */
export function parseHostAllowlist(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase().replace(/^\*?\./, "").replace(/\.$/, ""))
    .filter(Boolean);
}

/** An entry matches the exact host or any subdomain of it. */
export function hostAllowed(hostname: string, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return true;
  return allowlist.some((entry) => hostname === entry || hostname.endsWith(`.${entry}`));
}

export function validateFetchUrl(
  raw: string,
  opts: { allowlist?: readonly string[] } = {},
): ValidatedUrl {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LENGTH) {
    throw new UrlRejection("invalid_url", "URL is missing or too long");
  }
  if (/[\u0000-\u0020\u007f]/.test(raw.trim()) || raw !== raw.trim()) {
    throw new UrlRejection("invalid_url", "URL contains whitespace or control characters");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlRejection("invalid_url", "URL could not be parsed");
  }
  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw new UrlRejection("unsafe_scheme", `scheme ${url.protocol} is not allowed`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new UrlRejection("credentials_in_url", "URLs with embedded credentials are not allowed");
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    throw new UrlRejection("blocked_port", "only ports 80 and 443 are allowed");
  }

  // WHATWG parsing already canonicalises decimal/octal/hex IPv4 forms
  // (2130706433, 0177.0.0.1, 0x7f.1, 127.1) to dotted quads.
  let hostname = url.hostname.toLowerCase();
  if (hostname.startsWith("[") && hostname.endsWith("]")) hostname = hostname.slice(1, -1);
  hostname = hostname.replace(/\.$/, "");
  if (hostname === "") throw new UrlRejection("invalid_url", "URL has no host");

  const family = isIP(hostname);
  if (family !== 0) {
    if (isBlockedAddress(hostname)) {
      throw new UrlRejection("blocked_address", "target address is not a public address");
    }
    if (!hostAllowed(hostname, opts.allowlist ?? [])) {
      throw new UrlRejection("not_allowlisted", "host is not on the allowlist");
    }
    return { url, hostname, ipLiteral: { address: hostname, family: family as 4 | 6 } };
  }

  if (
    hostname === "localhost" ||
    !hostname.includes(".") ||
    BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  ) {
    throw new UrlRejection("blocked_host", "target host is local or internal");
  }
  if (!hostAllowed(hostname, opts.allowlist ?? [])) {
    throw new UrlRejection("not_allowlisted", "host is not on the allowlist");
  }
  return { url, hostname, ipLiteral: null };
}
