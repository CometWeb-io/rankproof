import { fetchJson, mapLimit, type Budget } from "./net.server.ts";

type DohAnswer = { Answer?: { type?: number; data?: string }[] };

const RESOLVERS = ["https://dns.google/resolve", "https://cloudflare-dns.com/dns-query"];

/**
 * Resolves domain IP addresses over public DNS-over-HTTPS. Commercial tools show
 * "referring IPs" and "referring subnets" — many domains in one /24 subnet is
 * the classic signal of a private blog network.
 */
export async function resolveIps(domain: string, budget: Budget): Promise<string[]> {
  for (const resolver of RESOLVERS) {
    try {
      const data = await fetchJson<DohAnswer>(
        `${resolver}?name=${encodeURIComponent(domain)}&type=A`,
        budget.timeout(4500),
        undefined,
        budget.signal,
      );
      const ips = (data.Answer ?? [])
        .filter((row) => row.type === 1 && row.data)
        .map((row) => row.data as string)
        .filter((ip) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip));
      if (ips.length > 0) return [...new Set(ips)].slice(0, 4);
    } catch {
      /* try the next resolver */
    }
  }
  return [];
}

export function subnetOf(ip: string): string | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}

export async function resolveDomains(
  domains: string[],
  budget: Budget,
  limit = 40,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const list = domains.slice(0, limit);
  await mapLimit(list, 8, async (domain) => {
    if (budget.left() < 1500) return;
    const ips = await resolveIps(domain, budget);
    if (ips.length > 0) out.set(domain, ips);
  });
  return out;
}
