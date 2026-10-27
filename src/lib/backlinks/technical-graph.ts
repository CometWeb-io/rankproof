import { captureSafeUrl } from "./evidence-capture.ts";
import { normalizeUrl } from "./parse.ts";
import type { SiteAudit } from "./types.ts";

export type GraphRedirect = { from: string; to: string; status: number };

export type GraphObservation = {
  url: string;
  links: string[];
  hreflang?: { language: string; url: string }[];
  pagination?: { relation: "next" | "prev"; url: string }[];
  /** Actual fetched resource after redirects; links may belong to this document. */
  resolvedUrl?: string;
  requestedUrl?: string;
  evidenceRef: string;
};
export type GraphInventory = {
  source: "sitemap" | "gsc" | "cms" | "supplied";
  urls: string[];
  complete: boolean;
  documentUrl?: string;
  evidenceRef: string;
};
export type TechnicalGraphInput = {
  rootUrl: string;
  requestedRootUrl?: string;
  audit: SiteAudit;
  observations: GraphObservation[];
  inventories: GraphInventory[];
  crawl: {
    frontierExhausted: boolean;
    blockedUrls: string[];
    failedUrls: string[];
    redactedUrlCount?: number;
    redirects?: GraphRedirect[];
  };
};

function pageUrl(raw: string, base: string): string {
  const url = new URL(raw, base);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password)
    throw new Error("Invalid graph URL.");
  const normalized = normalizeUrl(url.href);
  if (!captureSafeUrl(normalized)) throw new Error("Unsafe graph URL.");
  return normalized;
}

export function buildTechnicalGraph(input: TechnicalGraphInput) {
  const root = pageUrl(input.rootUrl, input.rootUrl);
  const origin = new URL(root).origin;
  const internal = (url: string) => new URL(url).origin === origin;
  if (
    !input.audit ||
    !Array.isArray(input.audit.pages) ||
    !Array.isArray(input.observations) ||
    !Array.isArray(input.inventories) ||
    input.audit.pages.length > 100_000 ||
    input.observations.length > 100_000 ||
    input.inventories.length > 100 ||
    (input.crawl?.redirects !== undefined &&
      (!Array.isArray(input.crawl.redirects) || input.crawl.redirects.length > 500_000)) ||
    !input.crawl ||
    !Array.isArray(input.crawl.blockedUrls) ||
    !Array.isArray(input.crawl.failedUrls) ||
    typeof input.crawl.frontierExhausted !== "boolean"
  )
    throw new Error("Invalid or oversized graph input.");
  const pages = new Map(input.audit.pages.map((p) => [pageUrl(p.url, root), p]));
  if (pages.size !== input.audit.pages.length) throw new Error("Duplicate audited page URLs.");
  if ([...pages.keys()].some((url) => !internal(url)))
    throw new Error("Audit exceeds the declared origin scope.");
  const observations = new Map<string, GraphObservation>();
  let edgeCount = 0;
  for (const observation of input.observations) {
    const url = pageUrl(observation.url, root);
    if (
      !internal(url) ||
      (observation.resolvedUrl !== undefined && pageUrl(observation.resolvedUrl, url) !== url) ||
      !pages.has(url) ||
      observations.has(url) ||
      !observation.evidenceRef?.trim() ||
      !Array.isArray(observation.links)
    ) {
      throw new Error("Graph observations need unique audited URLs and evidence references.");
    }
    edgeCount +=
      observation.links.length +
      (observation.hreflang?.length ?? 0) +
      (observation.pagination?.length ?? 0);
    if (edgeCount > 1_000_000) throw new Error("Graph edge limit exceeded.");
    observations.set(url, {
      ...observation,
      ...(observation.requestedUrl
        ? { requestedUrl: pageUrl(observation.requestedUrl, root) }
        : {}),
      links: [...new Set(observation.links.map((link) => pageUrl(link, url)))].filter(internal),
      hreflang: observation.hreflang?.map((h) => {
        if (!h.language?.trim()) throw new Error("Missing hreflang language.");
        return { language: h.language, url: pageUrl(h.url, url) };
      }),
      pagination: observation.pagination?.map((p) => {
        if (p.relation !== "next" && p.relation !== "prev")
          throw new Error("Invalid pagination relation.");
        return { ...p, url: pageUrl(p.url, url) };
      }),
    });
  }
  const inventory = new Map<string, { source: GraphInventory["source"]; evidenceRef: string }[]>();
  let inventoryCount = 0;
  let redactedUrlCount = input.crawl.redactedUrlCount ?? 0;
  if (!Number.isSafeInteger(redactedUrlCount) || redactedUrlCount < 0)
    throw new Error("Invalid redaction count.");
  for (const list of input.inventories) {
    if (
      !Array.isArray(list.urls) ||
      !["sitemap", "gsc", "cms", "supplied"].includes(list.source) ||
      typeof list.complete !== "boolean" ||
      !list.evidenceRef?.trim()
    ) {
      throw new Error("Invalid inventory provenance.");
    }
    inventoryCount += list.urls.length;
    if (inventoryCount > 100_000) throw new Error("Inventory URL limit exceeded.");
    for (const raw of list.urls) {
      const normalized = normalizeUrl(new URL(raw, root).href);
      if (!captureSafeUrl(normalized)) {
        redactedUrlCount++;
        continue;
      }
      const url = pageUrl(raw, root);
      if (!internal(url)) throw new Error("Inventory exceeds the declared origin scope.");
      const refs = inventory.get(url) ?? [];
      refs.push({ source: list.source, evidenceRef: list.evidenceRef });
      inventory.set(url, refs);
    }
  }
  const redirects = (input.crawl.redirects ?? []).map((hop) => {
    if (!Number.isInteger(hop.status) || hop.status < 300 || hop.status >= 400)
      throw new Error("Invalid observed redirect status.");
    return { from: pageUrl(hop.from, root), to: pageUrl(hop.to, root), status: hop.status };
  });
  const redirectSources = new Set(redirects.map((hop) => hop.from));
  const redirectTargets = new Map<string, string[]>();
  for (const hop of redirects)
    if (internal(hop.from) && internal(hop.to)) {
      const targets = redirectTargets.get(hop.from) ?? [];
      targets.push(hop.to);
      redirectTargets.set(hop.from, targets);
    }
  const depth = new Map<string, number>([[root, 0]]);
  const queue = [root];
  for (let index = 0; index < queue.length; index++) {
    const url = queue[index]!;
    const neighbors = [
      ...(observations.get(url)?.links ?? []).map((to) => ({ to, cost: 1 })),
      ...(redirectTargets.get(url) ?? []).map((to) => ({ to, cost: 0 })),
    ];
    for (const { to, cost } of neighbors) {
      const candidate = depth.get(url)! + cost;
      if (!depth.has(to) || candidate < depth.get(to)!) {
        depth.set(to, candidate);
        queue.push(to);
      }
    }
  }
  const missingObservations = [...depth.keys()].filter(
    (url) => !observations.has(url) && !redirectTargets.has(url),
  );
  const safeCoverageUrls = (urls: string[]) =>
    urls.flatMap((raw) => {
      const normalized = normalizeUrl(new URL(raw, root).href);
      if (!captureSafeUrl(normalized)) {
        redactedUrlCount++;
        return [];
      }
      return [pageUrl(normalized, root)];
    });
  const blockedUrls = safeCoverageUrls(input.crawl.blockedUrls);
  const failedUrls = safeCoverageUrls(input.crawl.failedUrls);
  const complete =
    redactedUrlCount === 0 &&
    input.audit.status !== "failed" &&
    input.crawl.frontierExhausted &&
    input.crawl.blockedUrls.length === 0 &&
    input.crawl.failedUrls.length === 0 &&
    missingObservations.length === 0 &&
    [...depth.keys()].every((url) => {
      const page = pages.get(url);
      return (
        redirectTargets.has(url) ||
        (page && page.status >= 200 && page.status < 300 && !page.redirected)
      );
    });
  const issues: { kind: string; urls: string[]; evidenceRefs: string[] }[] = [];
  const parent = new Map([...pages.keys()].map((url) => [url, url]));
  const find = (url: string): string => {
    let current = url;
    while (parent.get(current) !== current) current = parent.get(current)!;
    let node = url;
    while (parent.get(node) !== node) {
      const next = parent.get(node)!;
      parent.set(node, current);
      node = next;
    }
    return current;
  };
  const canonicals = new Map<string, string>();
  for (const [url, page] of pages) {
    if (!page.canonical) continue;
    let canonical: string;
    try {
      canonical = pageUrl(page.canonical, url);
    } catch {
      issues.push({
        kind: "canonical-invalid-url",
        urls: [url],
        evidenceRefs: observations.has(url) ? [observations.get(url)!.evidenceRef] : [],
      });
      continue;
    }
    canonicals.set(url, canonical);
    if (pages.has(canonical)) parent.set(find(url), find(canonical));
    const target = pages.get(canonical);
    const observed = redirectSources.has(canonical) || (target && target.status > 0);
    if (
      !observed ||
      redirectSources.has(canonical) ||
      !target ||
      target.noindex ||
      target.status < 200 ||
      target.status >= 300 ||
      target.redirected
    ) {
      issues.push({
        kind: observed ? "canonical-unusable-target" : "canonical-target-unobserved",
        urls: [url, canonical],
        evidenceRefs: observations.has(url) ? [observations.get(url)!.evidenceRef] : [],
      });
    }
  }

  const done = new Set<string>();
  for (const start of canonicals.keys()) {
    const path: string[] = [];
    const positions = new Map<string, number>();
    let current = start;
    while (canonicals.has(current) && !done.has(current)) {
      if (positions.has(current)) {
        const cycle = path.slice(positions.get(current)!);
        if (cycle.length > 1)
          issues.push({
            kind: "canonical-cycle",
            urls: cycle,
            evidenceRefs: cycle.flatMap((url) =>
              observations.has(url) ? [observations.get(url)!.evidenceRef] : [],
            ),
          });
        break;
      }
      positions.set(current, path.length);
      path.push(current);
      current = canonicals.get(current)!;
    }
    path.forEach((url) => done.add(url));
  }
  const clusters = new Map<string, string[]>();
  for (const url of pages.keys()) {
    const key = find(url);
    const group = clusters.get(key) ?? [];
    group.push(url);
    clusters.set(key, group);
  }
  const hreflang = [...observations].flatMap(([url, observation]) =>
    (observation.hreflang ?? []).map((alternate) => {
      const target = observations.get(alternate.url);
      return {
        from: url,
        ...alternate,
        targetEligibility: redirectSources.has(alternate.url)
          ? "unusable"
          : !pages.has(alternate.url) || pages.get(alternate.url)!.status === 0
            ? "unknown"
            : pages.get(alternate.url)!.noindex ||
                pages.get(alternate.url)!.redirected ||
                pages.get(alternate.url)!.status < 200 ||
                pages.get(alternate.url)!.status >= 300
              ? "unusable"
              : target
                ? "observed-success"
                : "unknown",
        reciprocity: target
          ? target.hreflang?.some((h) => h.url === url)
            ? "observed"
            : "missing"
          : "unknown",
        evidenceRef: observation.evidenceRef,
      };
    }),
  );
  for (const [url, observation] of observations) {
    const locales = new Map<string, Set<string>>();
    for (const alternate of observation.hreflang ?? []) {
      const key = alternate.language.trim().toLowerCase();
      const targets = locales.get(key) ?? new Set<string>();
      targets.add(alternate.url);
      locales.set(key, targets);
    }
    for (const targets of locales.values())
      if (targets.size > 1)
        issues.push({
          kind: "hreflang-conflicting-locale",
          urls: [url, ...targets],
          evidenceRefs: [observation.evidenceRef],
        });
  }
  for (const alternate of hreflang) {
    if (alternate.reciprocity === "missing" || alternate.targetEligibility === "unusable")
      issues.push({
        kind:
          alternate.targetEligibility === "unusable"
            ? "hreflang-unusable-target"
            : "hreflang-missing-return",
        urls: [alternate.from, alternate.url],
        evidenceRefs: [
          alternate.evidenceRef,
          ...(observations.has(alternate.url)
            ? [observations.get(alternate.url)!.evidenceRef]
            : []),
        ],
      });
  }
  const sitemapUrls = [...inventory]
    .filter(([, refs]) => refs.some((r) => r.source === "sitemap"))
    .map(([url]) => url);
  const facetMap = new Map<string, string[]>();
  for (const url of new Set([...pages.keys(), ...inventory.keys()])) {
    const parsed = new URL(url);
    if (!parsed.search) continue;
    const key = parsed.origin + parsed.pathname;
    const group = facetMap.get(key) ?? [];
    group.push(url);
    facetMap.set(key, group);
  }
  const queryNavigation = new Map<string, { from: string; to: string; evidenceRef: string }[]>();
  for (const [from, observation] of observations)
    for (const to of observation.links) {
      const parsed = new URL(to);
      if (!parsed.search) continue;
      const key = parsed.origin + parsed.pathname;
      const links = queryNavigation.get(key) ?? [];
      links.push({ from, to, evidenceRef: observation.evidenceRef });
      queryNavigation.set(key, links);
    }
  const orphanCandidates = [...inventory]
    .filter(([url]) => !depth.has(url))
    .map(([url, sources]) => ({
      url,
      sources,
      status: complete ? "unreachable-in-observed-graph" : "inventory-not-reached",
      existence:
        observations.has(url) && pages.get(url)!.status >= 200 && pages.get(url)!.status < 300
          ? "observed-success"
          : "unknown",
    }));
  const repairTargets = [
    ...issues.flatMap((issue) =>
      issue.urls.map((url) => ({
        kind: issue.kind,
        url,
        relatedUrls: issue.urls.filter((other) => other !== url),
        evidenceRefs: issue.evidenceRefs,
        certainty: "observed-declaration",
      })),
    ),
    ...[...depth]
      .filter(([, value]) => value >= 4)
      .map(([url]) => ({
        kind: "deep-page",
        url,
        relatedUrls: [] as string[],
        evidenceRefs: observations.has(url) ? [observations.get(url)!.evidenceRef] : [],
        certainty: "observed-reachability",
      })),
    ...orphanCandidates.map((candidate) => ({
      kind: "orphan-investigation",
      url: candidate.url,
      relatedUrls: [] as string[],
      evidenceRefs: candidate.sources.map((source) => source.evidenceRef),
      certainty: "candidate",
    })),
  ];
  return {
    schemaVersion: 2,
    scope: {
      origin,
      rootUrl: root,
      requestedRootUrl: pageUrl(input.requestedRootUrl ?? root, root),
      identity: "exact-url-without-fragment",
    },
    coverage: {
      crawlCompleteWithinOrigin: complete,
      inventoryComplete:
        redactedUrlCount === 0 &&
        input.inventories.length > 0 &&
        input.inventories.every((i) => i.complete),
      redactedUrlCount,
      knownPages: pages.size,
      auditedPages: [...pages.values()].filter((page) => page.status > 0).length,
      observedLinkPages: observations.size,
      reachedUrls: depth.size,
      missingObservations,
      blockedUrls,
      failedUrls,
      sitemap: {
        inventory: sitemapUrls.length,
        reached: sitemapUrls.filter((url) => depth.has(url)).length,
        unobserved: sitemapUrls.filter(
          (url) =>
            !redirectSources.has(url) && !(pages.get(url)?.status && pages.get(url)!.status > 0),
        ),
      },
    },
    inventories: input.inventories.map(({ source, complete, evidenceRef, documentUrl }) => ({
      source,
      complete,
      evidenceRef,
      ...(documentUrl ? { documentUrl: pageUrl(documentUrl, root) } : {}),
    })),
    redirects,
    documentResolutions: [...observations]
      .filter(([url, observation]) => observation.requestedUrl && observation.requestedUrl !== url)
      .map(([documentUrl, observation]) => ({
        requestedUrl: observation.requestedUrl!,
        documentUrl,
      })),
    repairTargets,
    depths: [...depth].map(([url, depth]) => ({ url, depth })),
    edges: [...observations].flatMap(([from, o]) =>
      o.links.map((to) => ({ from, to, evidenceRef: o.evidenceRef })),
    ),
    canonicalClusters: [...clusters.values()]
      .filter((urls) => urls.length > 1)
      .map((urls) => urls.sort()),
    hreflang,
    pagination: [...observations].flatMap(([from, o]) =>
      (o.pagination ?? []).map((p) => ({
        from,
        ...p,
        targetObserved: observations.has(p.url),
        evidenceRef: o.evidenceRef,
      })),
    ),
    facetCandidates: [...facetMap]
      .filter(([, urls]) => urls.length > 1)
      .map(([path, urls]) => ({
        path,
        urls,
        classification: "query-variants-not-proven-facets",
        parameterAxes: [
          ...new Set(urls.flatMap((url) => [...new URL(url).searchParams.keys()])),
        ].map((name) => ({
          name,
          values: [...new Set(urls.flatMap((url) => new URL(url).searchParams.getAll(name)))],
        })),
        navigation: queryNavigation.get(path) ?? [],
        sources: urls.map((url) => ({
          url,
          inventory: inventory.get(url) ?? [],
          observed: observations.has(url),
        })),
      })),
    orphanCandidates,
    issues,
    limitations: [
      "Origin-scoped imported graph; inventory completeness and crawl frontier are caller assertions.",
      "Unreachable URLs remain orphan candidates; no complete web or site inventory is assumed.",
      "Canonical clusters describe declarations, not search-engine canonical selection.",
    ],
  };
}

export type TechnicalGraphReport = ReturnType<typeof buildTechnicalGraph>;
