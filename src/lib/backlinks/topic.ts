// Stopword list covering English and Polish. Extend it for other markets.
const STOPWORDS = new Set(
  `a aby albo ale ani az aż bardzo bez bo być był była było były będzie będą co czy czyli dla do gdy gdzie go i ich ile im inne iz iż ja jak jako je jego jej jest jestem jeszcze już kiedy kto która który które których którym lat lub ma mają mamy me mi mnie moze może można my na nad nam nas nasz nasze nie niż no nowe o od on ona one oni oraz po pod ponad poza przed przez przy raz sa są się siebie sobie sposób swoje ta tak takie tam te tego tej ten teraz to tu tych tylko tym u w we wiele więc wszystko z za ze że
  the a an and or of for from with to in on at by is are was were be been being this that these those it its as not no but if then than so such can could will would should may might must have has had do does did done you your we our they their he she his her i me my mine us them there here what which who whom whose when where why how all any both each few more most other some only own same too very just about into over after before between during without within
  strona strony stron www http https html sklep firma firmy nasz nasze oferta oferty kontakt cookie cookies polityka prywatnosci prywatności regulamin menu zobacz wiecej więcej czytaj home page site web new news blog post posts search zaloguj koszyk`
    .split(/\s+/)
    .filter(Boolean),
);

/** Normalises text into comparable tokens (diacritics removed). */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((token) => token.replace(/^-+|-+$/g, ""))
    .filter((token) => token.length >= 4 && token.length <= 24)
    .filter((token) => !/^\d+$/.test(token))
    .filter((token) => !STOPWORDS.has(token));
}

/** The document's most frequent terms with weights (normalised frequency). */
export function topTerms(text: string, limit = 40): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokenize(text).slice(0, 6000)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  const max = sorted[0]?.[1] ?? 1;
  return new Map(sorted.map(([term, count]) => [term, count / max]));
}

/**
 * Topical match (0-100). A link from a site on the same subject is worth
 * worth far more than an incidental mention — commercial tools call this
 * relevance or topical trust. We compute the weighted coverage of the target's
 * terms by the source page's terms, plus a bonus for the brand name and anchor.
 */
export function relevanceScore(
  sourceText: string,
  targetTerms: Map<string, number>,
  extras: { anchor?: string; brandTokens?: string[] } = {},
): number {
  if (targetTerms.size === 0) return 50;
  const source = topTerms(sourceText, 120);
  if (source.size === 0) return 20;

  let overlap = 0;
  let total = 0;
  for (const [term, weight] of targetTerms) {
    total += weight;
    const hit = source.get(term);
    if (hit !== undefined) overlap += weight * Math.min(1, 0.4 + hit);
  }
  let score = total > 0 ? (overlap / total) * 100 : 0;

  const anchorTokens = tokenize(extras.anchor ?? "");
  if (anchorTokens.some((token) => targetTerms.has(token))) score += 12;
  const brand = (extras.brandTokens ?? []).map((token) => token.toLowerCase());
  if (brand.some((token) => token.length >= 4 && sourceText.toLowerCase().includes(token))) {
    score += 8;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function mergeTerms(chunks: string[], limit = 40): Map<string, number> {
  return topTerms(chunks.join(" \n "), limit);
}
