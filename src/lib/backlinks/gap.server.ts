import { parseTarget, registrableDomain } from "./parse.ts";
import { runScan } from "./engine.server.ts";
import type { GapResult, LinkGapDomain, LinkGapReport, ScanReport } from "./types.ts";

const MAX_COMPETITORS = 5;

type Profile = {
  host: string;
  domains: Map<string, { score: number; url: string; dofollow: boolean }>;
  report: ScanReport | null;
  error?: string;
};

async function profileOf(input: string, light: boolean): Promise<Profile> {
  const host = parseTarget(input).host;
  const result = await runScan(input, light ? { mode: "light" } : {});
  if (!result.ok) {
    return { host, domains: new Map(), report: null, error: result.error };
  }
  const domains = new Map<string, { score: number; url: string; dofollow: boolean }>();
  for (const domain of result.report.analytics.referringDomains) {
    domains.set(domain.domain, {
      score: domain.domainScore,
      url: domain.sampleUrl,
      dofollow: domain.dofollow > 0,
    });
  }
  return { host, domains, report: result.report };
}

/**
 * Analiza luki linkowej („Link Intersect” w Ahrefs, „Backlink Gap” w Semrush):
 * domains that link to competitors but not to you — sorted by quality and by
 * how many competitors already hold that link.
 */
export async function runLinkGap(
  targetInput: string,
  competitorInputs: string[],
): Promise<GapResult> {
  let target: Profile;
  try {
    target = await profileOf(targetInput, false);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Invalid address.",
    };
  }
  if (target.error) return { ok: false, error: target.error };

  const inputs = [...new Set(competitorInputs.map((c) => c.trim()).filter(Boolean))]
    .filter((c) => registrableDomain(c) !== registrableDomain(target.host))
    .slice(0, MAX_COMPETITORS);
  if (inputs.length === 0) {
    return { ok: false, error: "Enter at least one competitor domain." };
  }

  const settled = await Promise.all(
    inputs.map(async (input) => {
      try {
        return await profileOf(input, true);
      } catch (err) {
        return {
          host: input,
          domains: new Map(),
          report: null,
          error: err instanceof Error ? err.message : "The scan failed.",
        } satisfies Profile;
      }
    }),
  );

  const gapMap = new Map<string, LinkGapDomain>();
  const shared = new Set<string>();
  for (const competitor of settled) {
    for (const [domain, info] of competitor.domains) {
      if (target.domains.has(domain)) {
        shared.add(domain);
        continue;
      }
      const current = gapMap.get(domain);
      if (current) {
        if (!current.competitors.includes(competitor.host)) {
          current.competitors.push(competitor.host);
        }
        current.domainScore = Math.max(current.domainScore, info.score);
        current.dofollow = current.dofollow || info.dofollow;
        continue;
      }
      gapMap.set(domain, {
        domain,
        domainScore: info.score,
        priority: 0,
        competitors: [competitor.host],
        sampleUrl: info.url,
        dofollow: info.dofollow,
      });
    }
  }

  const competitorDomains = new Set(
    settled.flatMap((competitor) => [...competitor.domains.keys()]),
  );

  const report: LinkGapReport = {
    target: target.host,
    competitors: settled.map((competitor) => ({
      host: competitor.host,
      referringDomains: competitor.domains.size,
      backlinks: competitor.report?.stats.backlinks ?? 0,
      domainRating: competitor.report?.stats.domainRating ?? 0,
      error: competitor.error,
    })),
    shared: [...shared].sort(),
    gap: [...gapMap.values()]
      .map((item) => ({
        ...item,
        // A link every competitor has is both easier to win and more costly to
        // lack — hence the weight on the competitor count.
        priority: Math.max(
          1,
          Math.min(
            100,
            Math.round(
              item.domainScore * 0.55 +
                (item.competitors.length / Math.max(1, inputs.length)) * 35 +
                (item.dofollow ? 10 : 0),
            ),
          ),
        ),
      }))
      .sort(
        (a, b) =>
          b.priority - a.priority ||
          b.competitors.length - a.competitors.length ||
          b.domainScore - a.domainScore,
      ),
    unique: [...target.domains.keys()].filter((d) => !competitorDomains.has(d)).sort(),
    queriedAt: new Date().toISOString(),
  };

  return { ok: true, report };
}
