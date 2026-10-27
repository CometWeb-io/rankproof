import type { Backlink } from "./types.ts";
import type { DomainEdge } from "./graph.ts";

/** Legacy verified rows retain their state; provider/archive evidence is never current. */
export function isCurrentBacklink(link: Backlink): boolean {
  return (
    link.state === "live" &&
    link.verified === true &&
    (!link.evidence ||
      (link.evidence.kind === "html_anchor" && link.evidence.method === "fetched_html"))
  );
}

/** Context edges come only from freshly fetched HTML, never from archive/provider reports. */
export function partitionLinkGraphs(
  links: Backlink[],
  targetDomain: string,
  context: DomainEdge[] = [],
) {
  const live = links.filter(isCurrentBacklink);
  const historical = links.filter((link) => link.state === "lost");
  const unverified = links.filter((link) => link.state !== "lost" && !isCurrentBacklink(link));
  const edges = (rows: Backlink[]) =>
    rows.map((link) => ({ from: link.sourceDomain, to: targetDomain, weight: 3 }));
  return {
    live: { links: live, edges: [...context, ...edges(live)] },
    historical: { links: historical, edges: edges(historical) },
    unverified: { links: unverified, edges: edges(unverified) },
  };
}
