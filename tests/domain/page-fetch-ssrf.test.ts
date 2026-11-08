import { describe, expect, it } from "vitest";
import {
  UrlRejection,
  hostAllowed,
  isBlockedAddress,
  parseHostAllowlist,
  validateFetchUrl,
} from "@/lib/integrations/page-fetch/ssrf";

function reasonOf(url: string, allowlist?: string[]): string | null {
  try {
    validateFetchUrl(url, { allowlist });
    return null;
  } catch (error) {
    if (error instanceof UrlRejection) return error.reason;
    throw error;
  }
}

describe("direct fetch SSRF: address classification", () => {
  it.each([
    "0.0.0.0",
    "0.1.2.3",
    "10.0.0.1",
    "10.255.255.255",
    "100.64.0.1",
    "100.100.100.200",
    "127.0.0.1",
    "127.255.255.254",
    "169.254.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.1",
    "192.0.2.1",
    "192.168.0.1",
    "192.168.255.255",
    "198.18.0.1",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1",
    "239.255.255.255",
    "240.0.0.1",
    "255.255.255.255",
  ])("blocks IPv4 %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(["1.1.1.1", "8.8.8.8", "93.184.216.34", "172.15.0.1", "172.32.0.1", "11.0.0.1", "100.63.255.255", "100.128.0.1", "198.20.0.1"])(
    "allows public IPv4 %s",
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );

  it.each([
    "::",
    "::1",
    "fe80::1",
    "febf::1",
    "fc00::1",
    "fd00:ec2::254", // AWS IPv6 metadata
    "fd12:3456:789a::1",
    "ff02::1",
    "fec0::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "::ffff:10.0.0.1",
    "::ffff:c0a8:0101",
    "::127.0.0.1", // deprecated IPv4-compatible
    "64:ff9b::7f00:1", // NAT64 wrapping loopback
    "64:ff9b::a9fe:a9fe", // NAT64 wrapping metadata
    "2002:7f00:1::1", // 6to4 wrapping loopback
    "2002:a9fe:a9fe::1", // 6to4 wrapping metadata
    "2001::1", // Teredo / 2001::/23
    "2001:db8::1", // documentation
    "100::1", // discard
  ])("blocks IPv6 %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(["2606:4700:4700::1111", "2001:4860:4860::8888", "2a00:1450:4001:81b::200e", "64:ff9b::808:808", "2002:0808:0808::1"])(
    "allows public IPv6 %s",
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );

  it("fails closed on non-IP and malformed input", () => {
    expect(isBlockedAddress("example.com")).toBe(true);
    expect(isBlockedAddress("")).toBe(true);
    expect(isBlockedAddress("1.2.3")).toBe(true);
    expect(isBlockedAddress("999.1.1.1")).toBe(true);
    expect(isBlockedAddress("fe80::1%eth0")).toBe(true);
  });

  it("accepts bracketed IPv6 literals", () => {
    expect(isBlockedAddress("[::1]")).toBe(true);
    expect(isBlockedAddress("[2606:4700:4700::1111]")).toBe(false);
  });
});

describe("direct fetch SSRF: URL validation", () => {
  it("accepts a normal public https page and lowercases the host", () => {
    const v = validateFetchUrl("https://Supplier.Example.com/products?id=1#frag");
    expect(v.hostname).toBe("supplier.example.com");
    expect(v.ipLiteral).toBeNull();
  });

  it("accepts http and explicit default ports", () => {
    expect(reasonOf("http://supplier.example.com/")).toBeNull();
    expect(reasonOf("https://supplier.example.com:443/")).toBeNull();
    expect(reasonOf("http://supplier.example.com:80/")).toBeNull();
  });

  it.each([
    "file:///etc/passwd",
    "file://localhost/etc/passwd",
    "ftp://supplier.example.com/file",
    "gopher://supplier.example.com/",
    "data:text/html,<script>alert(1)</script>",
    "javascript:alert(1)",
    "ws://supplier.example.com/",
    "ldap://supplier.example.com/",
    "dict://supplier.example.com:11211/",
  ])("rejects unsafe scheme %s", (url) => {
    expect(reasonOf(url)).toBe("unsafe_scheme");
  });

  it.each([
    "https://user:pass@supplier.example.com/",
    "https://user@supplier.example.com/",
    "https://:secret@supplier.example.com/",
    "https://supplier.example.com@evil.example.org/", // userinfo trick
  ])("rejects embedded credentials %s", (url) => {
    expect(reasonOf(url)).toBe("credentials_in_url");
  });

  it.each([
    "http://localhost/",
    "http://LOCALHOST:80/",
    "http://localhost./",
    "http://foo.localhost/",
    "http://printer.local/",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://db.internal/",
    "http://intranet/",
    "http://router.lan/",
    "http://nas.home.arpa/",
    "http://single-label/",
    "http://1.0.0.127.in-addr.arpa/",
  ])("rejects local/internal hostname %s", (url) => {
    expect(reasonOf(url)).toBe("blocked_host");
  });

  it.each([
    "http://127.0.0.1/",
    "http://127.0.0.1:80/",
    "http://10.0.0.5/",
    "http://172.16.5.5/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://169.254.169.254./latest/meta-data/",
    "http://100.100.100.200/",
    "http://0.0.0.0/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:a9fe:a9fe]/",
    "http://[fd00:ec2::254]/latest/meta-data/",
    "http://[fe80::1]/",
    // Alternative IPv4 spellings that WHATWG URL canonicalises to 127.0.0.1 / 169.254.169.254.
    "http://2130706433/",
    "http://0x7f000001/",
    "http://0x7f.0.0.1/",
    "http://0177.0.0.1/",
    "http://127.1/",
    "http://2852039166/",
    "http://0xa9.0xfe.0xa9.0xfe/",
  ])("rejects private/metadata address literal %s", (url) => {
    expect(reasonOf(url)).toBe("blocked_address");
  });

  it("allows a public IP literal (still pinned and validated per hop)", () => {
    const v = validateFetchUrl("http://93.184.216.34/");
    expect(v.ipLiteral).toEqual({ address: "93.184.216.34", family: 4 });
  });

  it.each([
    "http://supplier.example.com:8080/",
    "http://supplier.example.com:22/",
    "https://supplier.example.com:6379/",
    "http://supplier.example.com:65535/",
  ])("rejects non-web ports %s", (url) => {
    expect(reasonOf(url)).toBe("blocked_port");
  });

  it.each([
    "",
    "not a url",
    "//supplier.example.com/",
    "supplier.example.com",
    " https://supplier.example.com/",
    "https://supplier.example.com/ ",
    "https://supplier.example.com/a b",
    "https://supplier.example.com/\u0000",
    "http://",
    `https://supplier.example.com/${"a".repeat(2100)}`,
  ])("rejects malformed URL %j", (url) => {
    expect(reasonOf(url)).toBe("invalid_url");
  });

  it("does not let a host label trick pass the allowlist", () => {
    const allow = ["supplier.example.com"];
    expect(reasonOf("https://supplier.example.com/", allow)).toBeNull();
    expect(reasonOf("https://www.supplier.example.com/", allow)).toBeNull();
    expect(reasonOf("https://evil-supplier.example.com/", allow)).toBe("not_allowlisted");
    expect(reasonOf("https://supplier.example.com.evil.org/", allow)).toBe("not_allowlisted");
    expect(reasonOf("https://evil.org/?u=supplier.example.com", allow)).toBe("not_allowlisted");
    expect(reasonOf("http://93.184.216.34/", allow)).toBe("not_allowlisted");
  });
});

describe("direct fetch allowlist parsing", () => {
  it("parses comma/space separated entries, lowercases, strips wildcards and dots", () => {
    expect(parseHostAllowlist(" Supplier.com, *.Packaging.example.org  .kraft.io. ")).toEqual([
      "supplier.com",
      "packaging.example.org",
      "kraft.io",
    ]);
  });

  it("treats blank as no allowlist (any public host)", () => {
    expect(parseHostAllowlist("")).toEqual([]);
    expect(parseHostAllowlist(undefined)).toEqual([]);
    expect(hostAllowed("anything.example.com", [])).toBe(true);
  });
});
