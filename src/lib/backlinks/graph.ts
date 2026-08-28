import type { Backlink, ReferringDomain } from "./types.ts";

export type DomainEdge = { from: string; to: string; weight: number };

/**
 * PageRank over the domain graph discovered during the scan. This is not an
 * index of the whole web, but within one site's neighbourhood it orders domains
 * well: a site linked to by many other linkers receives a higher rank.
 */
export function pageRank(
  edges: DomainEdge[],
  opts: { damping?: number; iterations?: number } = {},
): Map<string, number> {
  const damping = opts.damping ?? 0.85;
  const iterations = opts.iterations ?? 24;

  const nodes = new Set<string>();
  const out = new Map<string, DomainEdge[]>();
  for (const edge of edges) {
    if (!edge.from || !edge.to || edge.from === edge.to) continue;
    nodes.add(edge.from);
    nodes.add(edge.to);
    const list = out.get(edge.from) ?? [];
    list.push(edge);
    out.set(edge.from, list);
  }
  const n = nodes.size;
  if (n === 0) return new Map();

  let rank = new Map<string, number>();
  for (const node of nodes) rank.set(node, 1 / n);

  for (let i = 0; i < iterations; i++) {
    const next = new Map<string, number>();
    for (const node of nodes) next.set(node, (1 - damping) / n);
    let dangling = 0;
    for (const node of nodes) {
      const links = out.get(node);
      const value = rank.get(node) ?? 0;
      if (!links || links.length === 0) {
        dangling += value;
        continue;
      }
      const totalWeight = links.reduce((sum, edge) => sum + edge.weight, 0) || 1;
      for (const edge of links) {
        const share = (value * edge.weight) / totalWeight;
        next.set(edge.to, (next.get(edge.to) ?? 0) + damping * share);
      }
    }
    if (dangling > 0) {
      const spread = (damping * dangling) / n;
      for (const node of nodes) next.set(node, (next.get(node) ?? 0) + spread);
    }
    rank = next;
  }
  return rank;
}

/** Normalises a raw rank to 0–100 (logarithmically, like DR/UR). */
export function rankToScore(rank: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  if (rank.size === 0) return out;
  const values = [...rank.values()];
  const max = Math.max(...values);
  if (max <= 0) return out;
  const logMax = Math.log1p(max * 1000);
  for (const [key, value] of rank) {
    const score = Math.round((Math.log1p(value * 1000) / logMax) * 100);
    out.set(key, Math.max(0, Math.min(100, score)));
  }
  return out;
}

/**
 * A Domain Rating proxy for the target: a logarithmic function of the summed
 * strength of referring domains. Nofollow links count fractionally and spam
 * barely at all — the same philosophy as commercial metrics, on public data.
 */
export function computeDomainRating(domains: ReferringDomain[]): number {
  if (domains.length === 0) return 0;
  let weight = 0;
  for (const domain of domains) {
    const quality = Math.max(0, domain.domainScore) / 100;
    const followFactor = domain.dofollow > 0 ? 1 : 0.35;
    const spamFactor = domain.spamScore >= 55 ? 0.15 : domain.spamScore >= 30 ? 0.6 : 1;
    const contentFactor = domain.contentLinks > 0 ? 1.15 : 0.9;
    const rankFactor = 0.6 + (domain.rank / 100) * 0.8;
    weight += quality * quality * followFactor * spamFactor * contentFactor * rankFactor;
  }
  const score = (Math.log1p(weight * 6) / Math.log1p(6 * 400)) * 100;
  return Math.max(0, Math.min(100, Math.round(score)));
}

/** The strength of a single target page (the URL Rating equivalent). */
export function computeUrlRating(links: Backlink[]): number {
  if (links.length === 0) return 0;
  let weight = 0;
  const seen = new Set<string>();
  for (const link of links) {
    if (seen.has(link.sourceDomain)) {
      weight += (link.domainScore / 100) * 0.15;
      continue;
    }
    seen.add(link.sourceDomain);
    const quality = link.domainScore / 100;
    const follow = link.effectiveFollow ? 1 : 0.35;
    const spam = link.spamScore >= 55 ? 0.15 : 1;
    weight += quality * quality * follow * spam;
  }
  const score = (Math.log1p(weight * 6) / Math.log1p(6 * 400)) * 100;
  return Math.max(0, Math.min(100, Math.round(score)));
}
