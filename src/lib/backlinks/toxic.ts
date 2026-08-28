import { registrableDomain, tldOf } from "./parse.ts";
import type {
  AnchorAudit,
  AnchorRisk,
  AnchorStat,
  AnchorType,
  Backlink,
  ReferringDomain,
  ToxicDomain,
  ToxicReport,
} from "./types.ts";

/* ------------------------------------------------------------------ */
/* Toxicity                                                         */
/* ------------------------------------------------------------------ */

const RISKY_TLD = new Set(["xyz", "top", "click", "loan", "work", "gq", "cf", "tk", "ml", "buzz"]);

const SPAM_ANCHOR =
  /\b(casino|kasyno|bet|bukmacher|viagra|cialis|porn|sex|escort|loan|kredyt chwilówk\w*|pożyczk\w* bez|replica|crypto pump|forex signals)\b/i;

export type ToxicInput = {
  domain: ReferringDomain;
  links: Backlink[];
};

/**
 * Domain toxicity (0–100). This is not the domain's own spamScore — it also
 * accounts for *how* the domain links: sitewide from a footer, exact-match on a
 * commercial keyword and zero topical relevance is a common bought-link
 * *heuristic*, even when the domain itself looks respectable.
 */
export function domainToxicity(input: ToxicInput): { score: number; reasons: string[] } {
  const { domain, links } = input;
  const reasons: string[] = [];
  let score = Math.round(domain.spamScore * 0.55);

  if (domain.spamScore >= 55) reasons.push("high domain spam risk");

  if (domain.domainScore <= 25) {
    score += 14;
    reasons.push("very weak domain");
  } else if (domain.domainScore >= 70) {
    score -= 12;
  }

  if (RISKY_TLD.has(domain.tld)) {
    score += 12;
    reasons.push(`risky TLD .${domain.tld}`);
  }

  if (domain.relevance <= 20) {
    score += 12;
    reasons.push("no topical relevance");
  }

  if (domain.sitewide && domain.contentLinks === 0) {
    score += 16;
    reasons.push("sitewide link outside content");
  }

  const exact = links.filter((link) => link.anchorType === "exact-match").length;
  if (links.length > 0 && exact / links.length >= 0.6 && links.length >= 2) {
    score += 14;
    reasons.push("exact-match anchors only");
  }

  if (links.some((link) => SPAM_ANCHOR.test(link.anchor) || SPAM_ANCHOR.test(link.sourceTitle))) {
    score += 22;
    reasons.push("high-risk subject matter (gambling / pharma / adult)");
  }

  const footerOnly =
    links.length > 0 && links.every((link) => link.placement === "footer" || link.placement === "sidebar");
  if (footerOnly) {
    score += 10;
    reasons.push("tylko stopka lub sidebar");
  }

  if (links.every((link) => !link.effectiveFollow) && links.length > 0) {
    // Nofollow does not harm rankings — the real risk is lower.
    score -= 8;
  }

  if (domain.links >= 25 && domain.pages <= 2) {
    score += 8;
    reasons.push("many links from a single page");
  }

  return { score: Math.max(0, Math.min(100, Math.round(score))), reasons };
}

/**
 * A toxicity audit of the whole profile. High scores mean **manual review**,
 * not an automatic Disavow submission — most sites never need Disavow.
 */
export function buildToxicReport(backlinks: Backlink[], domains: ReferringDomain[]): ToxicReport {
  const byDomain = new Map<string, Backlink[]>();
  for (const link of backlinks) {
    const list = byDomain.get(link.sourceDomain) ?? [];
    list.push(link);
    byDomain.set(link.sourceDomain, list);
  }

  const rows: ToxicDomain[] = domains.map((domain) => {
    const links = byDomain.get(domain.domain) ?? [];
    const { score, reasons } = domainToxicity({ domain, links });
    const verdict = score >= 65 ? "review" : score >= 40 ? "watch" : "ok";
    return {
      domain: domain.domain,
      links: domain.links,
      toxicity: score,
      spamScore: domain.spamScore,
      domainScore: domain.domainScore,
      relevance: domain.relevance,
      verdict,
      reasons: reasons.slice(0, 4),
      sampleUrl: domain.sampleUrl,
      sitewide: domain.sitewide,
    };
  });

  const sorted = rows.sort((a, b) => b.toxicity - a.toxicity || b.links - a.links);
  const disavowCount = sorted.filter((row) => row.verdict === "review").length;
  const watchCount = sorted.filter((row) => row.verdict === "watch").length;
  const toxicLinks = sorted
    .filter((row) => row.verdict !== "ok")
    .reduce((sum, row) => sum + row.links, 0);
  const avgToxicity =
    sorted.length > 0
      ? Math.round(sorted.reduce((sum, row) => sum + row.toxicity, 0) / sorted.length)
      : 0;

  return { domains: sorted, disavowCount, watchCount, toxicLinks, avgToxicity };
}

/**
 * Optional Disavow file draft for Google Search Console.
 * Only high-risk (`review`) domains are listed — still requires human confirmation.
 */
export function disavowFile(
  report: ToxicReport,
  options: { host: string; includeWatch?: boolean } = { host: "" },
): string {
  const rows = report.domains.filter((row) =>
    options.includeWatch ? row.verdict !== "ok" : row.verdict === "review",
  );
  const lines = [
    `# High-risk link draft — ${options.host || "link profile"}`,
    `# Generated: ${new Date().toISOString().slice(0, 10)} by RankProof`,
    "# MANUAL REVIEW REQUIRED. Most sites do not need a Disavow file.",
    "# Google: use Disavow primarily for clear spam / manual-action risk.",
    "# Do not submit this file without checking every domain.",
    "",
  ];
  for (const row of rows) {
    lines.push(
      `# toxicity ${row.toxicity}/100 · ${row.links} links · ${row.reasons.join(", ") || "general signals"}`,
    );
    lines.push(`domain:${row.domain}`);
  }
  if (rows.length === 0) {
    lines.push("# No high-risk domains flagged. Do not submit an empty Disavow.");
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Anchor audit                                                        */
/* ------------------------------------------------------------------ */

/** Healthy share ranges for each anchor type in a natural profile. */
const ANCHOR_TARGET: Record<AnchorType, { min: number; max: number; hint: string }> = {
  brand: { min: 30, max: 70, hint: "Brand anchors should dominate — that is how people link." },
  url: { min: 10, max: 40, hint: "Bare URLs are the natural result of citation." },
  generic: { min: 5, max: 30, hint: "\"here\", \"more\" — natural noise." },
  "long-tail": { min: 5, max: 30, hint: "Sentences and longer phrases from the content." },
  "exact-match": {
    min: 0,
    max: 12,
    hint: "High exact-match share can signal aggressive link building — treat as a review cue, not proof of bought links.",
  },
  image: { min: 0, max: 20, hint: "Image links — mind the alt attribute." },
  empty: { min: 0, max: 10, hint: "Empty anchors carry no context." },
};

/**
 * Checks whether the anchor distribution looks natural. Excess exact-match is
 * the most common cause of an algorithmic filter — which is why we separately compute
 * individual over-optimised anchors.
 */
export function buildAnchorAudit(
  anchors: AnchorStat[],
  types: { key: string; share: number; count?: number }[],
): AnchorAudit {
  const shareOf = (type: AnchorType) =>
    Math.round(types.find((item) => item.key === type)?.share ?? 0);

  const risks: AnchorRisk[] = (Object.keys(ANCHOR_TARGET) as AnchorType[]).map((type) => {
    const target = ANCHOR_TARGET[type];
    const share = shareOf(type);
    const verdict = share > target.max ? "high" : share < target.min ? "low" : "ok";
    return { type, share, min: target.min, max: target.max, verdict, hint: target.hint };
  });

  const overOptimized = anchors
    .filter((anchor) => anchor.type === "exact-match" && anchor.share > 8)
    .map((anchor) => ({ text: anchor.text, share: Math.round(anchor.share), domains: anchor.domains }))
    .slice(0, 8);

  const total = anchors.reduce((sum, anchor) => sum + anchor.count, 0);
  let entropy = 0;
  for (const anchor of anchors) {
    if (anchor.count <= 0 || total <= 0) continue;
    const p = anchor.count / total;
    entropy -= p * Math.log2(p);
  }
  const maxEntropy = Math.log2(Math.max(2, anchors.length));
  const diversity = Math.max(0, Math.min(100, Math.round((entropy / maxEntropy) * 100)));

  let score = 60 + Math.round(diversity * 0.25);
  const exact = shareOf("exact-match");
  if (exact > 25) score -= 35;
  else if (exact > 12) score -= 18;
  if (shareOf("brand") >= 30) score += 12;
  else if (shareOf("brand") < 10) score -= 10;
  if (overOptimized.length >= 3) score -= 10;
  if (anchors.length <= 2) score -= 12;

  return {
    risks,
    overOptimized,
    diversity,
    score: Math.max(0, Math.min(100, score)),
  };
}

/** Helper: does the domain look like a PBN from its name alone. */
export function looksLikePbn(host: string): boolean {
  const domain = registrableDomain(host);
  const label = domain.split(".")[0] ?? "";
  const tld = tldOf(host);
  const hyphens = (label.match(/-/g) ?? []).length;
  return (hyphens >= 3 && label.length > 18) || (RISKY_TLD.has(tld) && hyphens >= 2);
}
