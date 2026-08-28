/**
 * SSRF protection.
 *
 * The scanner fetches URLs supplied by whoever is using it. On a public
 * self-hosted instance that is a direct path into the internal network:
 * `http://169.254.169.254/` returns cloud instance credentials on most
 * providers, and `http://localhost:5432` reaches the database.
 *
 * We therefore resolve every hostname *before* connecting and refuse any
 * address that is not publicly routable — including on each redirect hop,
 * because a public host is free to redirect into private space.
 */

export type GuardVerdict =
  | { allowed: true; addresses: string[] }
  | { allowed: false; reason: string };

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  // Cloud metadata endpoints, blocked by name as well as by address.
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
]);

/** Only http(s). `file:`, `gopher:` and friends have no place here. */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/** CIDR blocks that must never be reachable from a user-supplied URL. */
const BLOCKED_V4: [string, number][] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // RFC 1918
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local — cloud metadata lives here
  ["172.16.0.0", 12], // RFC 1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.168.0.0", 16], // RFC 1918
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, includes broadcast
];

export function isPrivateIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) return false;
  for (const [base, bits] of BLOCKED_V4) {
    const baseValue = ipv4ToInt(base);
    if (baseValue === null) continue;
    const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
    if ((value & mask) >>> 0 === (baseValue & mask) >>> 0) return true;
  }
  return false;
}

/**
 * Expands an IPv6 address to its eight 16-bit groups. Returns null when the
 * text is not a valid address. We need the expanded form because `new URL()`
 * rewrites `::ffff:127.0.0.1` into `::ffff:7f00:1` — a textual match on the
 * dotted-quad form therefore never fires on a real request.
 */
export function expandIpv6(ip: string): number[] | null {
  let value = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  if (!value) return null;

  // A trailing dotted quad is the low 32 bits: rewrite it as two groups.
  const dotted = value.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted?.[1]) {
    const octets = dotted[1].split(".").map(Number);
    if (octets.some((o) => !Number.isInteger(o) || o > 255)) return null;
    const high = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const low = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    value = `${value.slice(0, -dotted[1].length)}${high.toString(16)}:${low.toString(16)}`;
  }

  const halves = value.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (!part) return [];
    const groups: number[] = [];
    for (const chunk of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(chunk)) return null;
      groups.push(Number.parseInt(chunk, 16));
    }
    return groups;
  };

  const head = parse(halves[0] ?? "");
  const tail = halves.length === 2 ? parse(halves[1] ?? "") : [];
  if (head === null || tail === null) return null;

  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...Array<number>(missing).fill(0), ...tail];
}

/**
 * Several IPv6 forms carry an IPv4 address inside them. Each one is a way to
 * reach 127.0.0.1 or 169.254.169.254 while looking like a v6 literal, so the
 * embedded address has to be pulled out and judged by the IPv4 rules.
 */
function embeddedIpv4(groups: number[]): string | null {
  const [a, b, c, d, e, f, g, h] = groups as [
    number, number, number, number, number, number, number, number,
  ];
  const quad = (high: number, low: number) =>
    `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;

  const zeroPrefix = a === 0 && b === 0 && c === 0 && d === 0;
  // ::ffff:0:0/96 — IPv4-mapped (the common case after URL normalisation).
  if (zeroPrefix && e === 0 && f === 0xffff) return quad(g, h);
  // ::ffff:0:0:0/64 — IPv4-translated (RFC 2765).
  if (zeroPrefix && e === 0xffff && f === 0) return quad(g, h);
  // ::/96 — deprecated IPv4-compatible. `::` and `::1` are handled separately.
  if (zeroPrefix && e === 0 && f === 0 && (g !== 0 || h > 1)) return quad(g, h);
  // 64:ff9b::/96 and 64:ff9b:1::/48 — NAT64 (RFC 6052, RFC 8215).
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) return quad(g, h);
  // 2002::/16 — 6to4 embeds the IPv4 address in the second and third groups.
  if (a === 0x2002) return quad(b, c);
  return null;
}

export function isPrivateIpv6(ip: string): boolean {
  const groups = expandIpv6(ip);
  if (groups === null) return false;

  const embedded = embeddedIpv4(groups);
  if (embedded !== null) return isPrivateIpv4(embedded);

  const [a, b] = groups as [number, number];
  // Unspecified (::) and loopback (::1).
  if (groups.every((g) => g === 0)) return true;
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true;
  if ((a & 0xfe00) === 0xfc00) return true; // fc00::/7 — unique local
  if ((a & 0xffc0) === 0xfe80) return true; // fe80::/10 — link-local
  if ((a & 0xff00) === 0xff00) return true; // ff00::/8 — multicast
  if (a === 0x0100 && b === 0) return true; // 100::/64 — discard-only
  if (a === 0x2001 && b === 0x0db8) return true; // 2001:db8::/32 — documentation
  if (a === 0x2001 && b <= 0x01ff) return true; // 2001::/23 — IETF protocol assignments
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  return ip.includes(":") ? isPrivateIpv6(ip) : isPrivateIpv4(ip);
}

/**
 * Synchronous checks that need no DNS: protocol, credentials, port and
 * literal addresses. Cheap enough to run on every URL we touch.
 */
export function guardUrl(raw: string): GuardVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { allowed: false, reason: "Malformed URL." };
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return { allowed: false, reason: `Protocol ${url.protocol} is not allowed.` };
  }
  // Credentials in a URL are a classic way to confuse naive parsers.
  if (url.username || url.password) {
    return { allowed: false, reason: "URLs with embedded credentials are not allowed." };
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname) return { allowed: false, reason: "Missing hostname." };
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { allowed: false, reason: `Host ${hostname} points at a local or metadata service.` };
  }
  if (hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.endsWith(".localhost")) {
    return { allowed: false, reason: `Host ${hostname} is an internal name.` };
  }
  // A bare hostname with no dot cannot be a public site.
  if (!hostname.includes(".") && !hostname.includes(":")) {
    return { allowed: false, reason: `Host ${hostname} is not a public domain name.` };
  }

  const literal = hostname.replace(/^\[|\]$/g, "");
  if (/^[\d.]+$/.test(literal) || literal.includes(":")) {
    if (isPrivateAddress(literal)) {
      return { allowed: false, reason: `Address ${literal} is not publicly routable.` };
    }
  }

  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (port !== 80 && port !== 443 && port !== 8080 && port !== 8443) {
    return { allowed: false, reason: `Port ${port} is not allowed.` };
  }

  // Literals carry their own address; hostnames get addresses from DNS.
  const addresses =
    /^[\d.]+$/.test(literal) || literal.includes(":") ? [literal] : [];
  return { allowed: true, addresses };
}

export type Resolver = (hostname: string) => Promise<string[]>;

/**
 * Full check: static rules plus DNS resolution. Returns the public addresses
 * that were validated so the caller can **pin** the TCP connection to them
 * (avoids classic DNS-rebinding TOCTOU where lookup and connect disagree).
 */
export async function guardUrlWithDns(raw: string, resolve: Resolver): Promise<GuardVerdict> {
  const staticVerdict = guardUrl(raw);
  if (!staticVerdict.allowed) return staticVerdict;

  const hostname = new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (/^[\d.]+$/.test(hostname) || hostname.includes(":")) {
    return { allowed: true, addresses: staticVerdict.addresses };
  }

  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch {
    return { allowed: false, reason: `Cannot resolve ${hostname}.` };
  }
  if (addresses.length === 0) {
    return { allowed: false, reason: `${hostname} has no DNS records.` };
  }
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      return {
        allowed: false,
        reason: `${hostname} resolves to a non-public address (${address}).`,
      };
    }
  }
  return { allowed: true, addresses };
}
