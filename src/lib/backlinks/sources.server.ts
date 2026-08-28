import { decodeText, parseSitemap, snippetAround, stripTags, unwrapRedirect } from "./html.ts";
import {
  domainFromUrl,
  hostFromUrl,
  isTargetHost,
  normalizeUrl,
  registrableDomain,
  sld,
  stripWww,
} from "./parse.ts";
import { API_UA, BROWSER_UA, fetchJson, fetchText } from "./net.server.ts";
import type { Backlink, DiscoverySource, Mention } from "./types.ts";

export type Candidate = {
  url: string;
  title: string;
  via: DiscoverySource;
  /** Priority hint — higher means verified sooner. */
  boost?: number;
};

export const WIKI_ORIGINS: { origin: string; lang: string }[] = [
  { origin: "https://en.wikipedia.org", lang: "en" },
  { origin: "https://pl.wikipedia.org", lang: "pl" },
  { origin: "https://de.wikipedia.org", lang: "de" },
  { origin: "https://fr.wikipedia.org", lang: "fr" },
  { origin: "https://es.wikipedia.org", lang: "es" },
  { origin: "https://it.wikipedia.org", lang: "it" },
  { origin: "https://nl.wikipedia.org", lang: "nl" },
  { origin: "https://pt.wikipedia.org", lang: "pt" },
  { origin: "https://cs.wikipedia.org", lang: "cs" },
  { origin: "https://sk.wikipedia.org", lang: "sk" },
  { origin: "https://uk.wikipedia.org", lang: "uk" },
  { origin: "https://ru.wikipedia.org", lang: "ru" },
  { origin: "https://sv.wikipedia.org", lang: "sv" },
  { origin: "https://ja.wikipedia.org", lang: "ja" },
  { origin: "https://commons.wikimedia.org", lang: "commons" },
  { origin: "https://www.wikidata.org", lang: "wd" },
  { origin: "https://en.wikinews.org", lang: "wikinews" },
  { origin: "https://en.wikibooks.org", lang: "wikibooks" },
];

const JUNK_HOST_RE = /notexists|localhost|example\.(com|net|org)|invalid$|\.local$|\.test$/i;

const SKIP_HOST_RE =
  /(?:^|\.)(googleapis|gstatic|google-analytics|googletagmanager|doubleclick|cloudflareinsights|cloudflare\.com|jsdelivr|unpkg|cdnjs|bootstrapcdn|fontawesome|cookieyes|cookiebot|gmpg|w3\.org|schema\.org|purl\.org|google\.com|g\.co|goo\.gl|ytimg|ggpht|gravatar|wp\.com|w\.org|archive\.org|web\.archive\.org|webcache\.googleusercontent\.com|translate\.google\.com|amp\.dev|paypal\.com|adobe\.com|whatsapp\.com|api\.whatsapp\.com)$/i;

export function isJunkHost(host: string): boolean {
  const h = stripWww(host);
  if (!h || h.length > 80 || !h.includes(".")) return true;
  if (JUNK_HOST_RE.test(h)) return true;
  const digitCount = (h.match(/\d/g) ?? []).length;
  if (digitCount > 8) return true;
  const labels = h.split(".");
  if (labels.some((label) => label.length > 28 && /\d/.test(label))) return true;
  if (labels[0] && labels[0].length > 24 && /\d/.test(labels[0])) return true;
  return false;
}

export function isSkippableOutbound(url: string, host: string): boolean {
  const h = stripWww(host);
  if (!h || isJunkHost(h)) return true;
  if (SKIP_HOST_RE.test(h)) return true;
  if (
    /\/sharer|\/shareArticle|\/intent\/tweet|\/dialog\/|\/tr\?|\/account\/|\/login|\/signin|\/donate|\/cdn-cgi\//i.test(
      url,
    )
  ) {
    return true;
  }
  return false;
}

export function makeMention(
  url: string,
  title: string,
  snippet: string,
  via: DiscoverySource,
  linkOpportunity = false,
): Mention {
  const host = hostFromUrl(url);
  return {
    sourceUrl: url,
    sourceHost: host,
    sourceDomain: registrableDomain(host),
    sourceTitle: title || host,
    snippet,
    discoveredVia: via,
    linkOpportunity,
  };
}

/* ------------------------------------------------------------------ */
/* Wikipedia / Wikimedia                                               */
/* ------------------------------------------------------------------ */

type WikiExt = {
  query?: {
    exturlusage?: { pageid: number; ns: number; title: string; url: string }[];
  };
};

function wikiPageUrl(origin: string, title: string): string {
  const encoded = encodeURIComponent(title.replaceAll(" ", "_")).replaceAll("%3A", ":");
  return `${origin}/wiki/${encoded}`;
}

export async function scanWikipedia(host: string, signal?: AbortSignal): Promise<Backlink[]> {
  const domain = registrableDomain(host);
  const hosts = Array.from(new Set([host, `www.${host}`, domain])).filter(Boolean);
  const jobs = WIKI_ORIGINS.flatMap((wiki) =>
    hosts.map(async (h) => {
      const api = `${wiki.origin}/w/api.php?action=query&list=exturlusage&euquery=${encodeURIComponent(
        h,
      )}&eulimit=50&eunamespace=0&format=json&origin=*`;
      const data = await fetchJson<WikiExt>(api, 9000, API_UA, signal);
      const rows = data.query?.exturlusage ?? [];
      return rows.map((row) => {
        const sourceUrl = wikiPageUrl(wiki.origin, row.title);
        const sourceHost = hostFromUrl(sourceUrl) || new URL(wiki.origin).hostname;
        return {
          sourceUrl,
          sourceHost,
          sourceDomain: registrableDomain(sourceHost),
          sourceTitle: row.title,
          targetUrl: row.url,
          anchor: row.title,
          rel: "nofollow" as const,
          discoveredVia: "wikipedia" as const,
          wikiLang: wiki.lang,
          verified: true,
        };
      });
    }),
  );
  const settled = await Promise.allSettled(jobs);
  const out: Backlink[] = [];
  const seen = new Set<string>();
  let anyOk = false;
  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    anyOk = true;
    for (const item of result.value) {
      if (!isTargetHost(hostFromUrl(item.targetUrl), host)) continue;
      const key = `${item.sourceUrl}|${normalizeUrl(item.targetUrl)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item as unknown as Backlink);
    }
  }
  if (!anyOk) throw new Error("Wikipedia unavailable");
  return out;
}

/* ------------------------------------------------------------------ */
/* Hacker News                                                         */
/* ------------------------------------------------------------------ */

type AlgoliaHit = {
  objectID: string;
  title?: string | null;
  story_title?: string | null;
  url?: string | null;
  story_url?: string | null;
  comment_text?: string | null;
  points?: number | null;
};
type AlgoliaRes = { hits?: AlgoliaHit[] };

export async function scanHackerNews(
  queries: string[],
  host: string,
  signal?: AbortSignal,
): Promise<{ backlinks: Partial<Backlink>[]; mentions: Mention[] }> {
  const backlinks: Partial<Backlink>[] = [];
  const mentions: Mention[] = [];
  const unique = [...new Set(queries.filter((q) => q.length >= 4))].slice(0, 3);
  const jobs = unique.flatMap((q) => [
    fetchJson<AlgoliaRes>(
      `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&restrictSearchableAttributes=url&hitsPerPage=30`,
      9000,
      API_UA,
      signal,
    ),
    fetchJson<AlgoliaRes>(
      `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(`"${q}"`)}&hitsPerPage=20`,
      9000,
      API_UA,
      signal,
    ),
  ]);
  const settled = await Promise.allSettled(jobs);
  if (settled.every((s) => s.status === "rejected")) {
    throw new Error("Hacker News unavailable");
  }
  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    for (const hit of result.value.hits ?? []) {
      const storyUrl = hit.url ?? hit.story_url;
      const sourceUrl = `https://news.ycombinator.com/item?id=${hit.objectID}`;
      const blob =
        `${hit.title ?? ""} ${hit.story_title ?? ""} ${storyUrl ?? ""} ${hit.comment_text ?? ""}`.toLowerCase();
      const relevant = unique.some((q) => blob.includes(q.toLowerCase()));
      if (!relevant) continue;
      if (storyUrl && isTargetHost(hostFromUrl(storyUrl), host)) {
        backlinks.push({
          sourceUrl,
          sourceHost: "news.ycombinator.com",
          sourceDomain: "ycombinator.com",
          sourceTitle: hit.title || hit.story_title || `HN #${hit.objectID}`,
          targetUrl: storyUrl,
          anchor: hit.title || host,
          rel: "nofollow",
          discoveredVia: "hacker-news",
          verified: true,
        });
      } else {
        const comment = hit.comment_text ? stripTags(hit.comment_text).slice(0, 260) : "";
        mentions.push(
          makeMention(
            sourceUrl,
            hit.title || hit.story_title || `HN #${hit.objectID}`,
            comment || `A Hacker News thread mentions ${host}`,
            "hacker-news",
            true,
          ),
        );
      }
    }
  }
  return { backlinks, mentions };
}

/* ------------------------------------------------------------------ */
/* Reddit                                                              */
/* ------------------------------------------------------------------ */

type RedditRes = {
  data?: {
    children?: {
      data?: {
        title?: string;
        url?: string;
        permalink?: string;
        selftext?: string;
        subreddit?: string;
        score?: number;
        num_comments?: number;
      };
    }[];
  };
};

export async function scanReddit(
  queries: string[],
  host: string,
  signal?: AbortSignal,
): Promise<{ backlinks: Partial<Backlink>[]; mentions: Mention[] }> {
  const backlinks: Partial<Backlink>[] = [];
  const mentions: Mention[] = [];
  const unique = [...new Set(queries.filter((q) => q.length >= 4))].slice(0, 2);
  const jobs = unique.flatMap((q) => [
    fetchJson<RedditRes>(
      `https://www.reddit.com/search.json?q=${encodeURIComponent(`url:"${q}"`)}&limit=25&sort=relevance&t=all&raw_json=1`,
      9000,
      API_UA,
      signal,
    ),
    fetchJson<RedditRes>(
      `https://www.reddit.com/search.json?q=${encodeURIComponent(`"${q}"`)}&limit=25&sort=relevance&t=all&raw_json=1`,
      9000,
      API_UA,
      signal,
    ),
  ]);
  const settled = await Promise.allSettled(jobs);
  if (settled.every((s) => s.status === "rejected")) {
    throw new Error("Reddit rejected the request");
  }
  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    for (const child of result.value.data?.children ?? []) {
      const post = child.data;
      if (!post?.permalink) continue;
      const sourceUrl = `https://www.reddit.com${post.permalink}`;
      const blob = `${post.title ?? ""} ${post.url ?? ""} ${post.selftext ?? ""}`;
      const relevant = unique.some((q) => blob.toLowerCase().includes(q.toLowerCase()));
      if (!relevant) continue;
      if (post.url && isTargetHost(hostFromUrl(post.url), host)) {
        backlinks.push({
          sourceUrl,
          sourceHost: "www.reddit.com",
          sourceDomain: "reddit.com",
          sourceTitle: post.title || `r/${post.subreddit ?? "reddit"}`,
          targetUrl: post.url,
          anchor: post.title || host,
          rel: "nofollow",
          discoveredVia: "reddit",
          verified: true,
        });
      } else {
        const snippet =
          snippetAround(post.selftext ?? "", host) ??
          `Dyskusja w r/${post.subreddit ?? "reddit"} wspomina ${host}`;
        mentions.push(
          makeMention(
            sourceUrl,
            post.title || `r/${post.subreddit ?? "reddit"}`,
            snippet.slice(0, 280),
            "reddit",
            true,
          ),
        );
      }
    }
  }
  return { backlinks, mentions };
}

/* ------------------------------------------------------------------ */
/* Bluesky (publiczne API, bez klucza)                                 */
/* ------------------------------------------------------------------ */

type BskyRes = {
  posts?: {
    uri?: string;
    author?: { handle?: string; displayName?: string };
    record?: { text?: string };
    embed?: { external?: { uri?: string; title?: string } };
  }[];
};

export async function scanBluesky(
  queries: string[],
  host: string,
  signal?: AbortSignal,
): Promise<{ backlinks: Partial<Backlink>[]; mentions: Mention[] }> {
  const backlinks: Partial<Backlink>[] = [];
  const mentions: Mention[] = [];
  const unique = [...new Set(queries.filter((q) => q.length >= 4))].slice(0, 2);
  const settled = await Promise.allSettled(
    unique.map((q) =>
      fetchJson<BskyRes>(
        `https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(q)}&limit=25`,
        9000,
        API_UA,
        signal,
      ),
    ),
  );
  if (settled.every((s) => s.status === "rejected")) {
    throw new Error("Bluesky unavailable");
  }
  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    for (const post of result.value.posts ?? []) {
      const handle = post.author?.handle;
      const rkey = post.uri?.split("/").at(-1);
      if (!handle || !rkey) continue;
      const sourceUrl = `https://bsky.app/profile/${handle}/post/${rkey}`;
      const text = post.record?.text ?? "";
      const external = post.embed?.external?.uri ?? "";
      const blob = `${text} ${external}`.toLowerCase();
      if (!unique.some((q) => blob.includes(q.toLowerCase()))) continue;
      if (external && isTargetHost(hostFromUrl(external), host)) {
        backlinks.push({
          sourceUrl,
          sourceHost: "bsky.app",
          sourceDomain: "bsky.app",
          sourceTitle: post.embed?.external?.title || `@${handle}` || "Bluesky",
          targetUrl: external,
          anchor: post.embed?.external?.title || host,
          rel: "nofollow",
          discoveredVia: "bluesky",
          verified: true,
        });
        continue;
      }
      mentions.push(
        makeMention(
          sourceUrl,
          post.author?.displayName || `@${handle}`,
          text.slice(0, 260) || `Wpis na Bluesky wspomina ${host}`,
          "bluesky",
          true,
        ),
      );
    }
  }
  return { backlinks, mentions };
}

/* ------------------------------------------------------------------ */
/* Stack Exchange                                                      */
/* ------------------------------------------------------------------ */

type SeRes = {
  items?: {
    question_id?: number;
    answer_id?: number;
    title?: string;
    excerpt?: string;
    item_type?: string;
  }[];
};

export async function scanStackExchange(host: string, signal?: AbortSignal): Promise<Candidate[]> {
  const sites = ["stackoverflow", "superuser", "webmasters"];
  const settled = await Promise.allSettled(
    sites.map((site) =>
      fetchJson<SeRes>(
        `https://api.stackexchange.com/2.3/search/excerpts?order=desc&sort=relevance&q=${encodeURIComponent(host)}&site=${site}&pagesize=15`,
        9000,
        API_UA,
        signal,
      ).then((res) => ({ site, res })),
    ),
  );
  if (settled.every((s) => s.status === "rejected")) {
    throw new Error("Stack Exchange unavailable");
  }
  const out: Candidate[] = [];
  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    const { site, res } = result.value;
    const origin =
      site === "stackoverflow" ? "https://stackoverflow.com" : `https://${site}.stackexchange.com`;
    for (const item of res.items ?? []) {
      const id = item.question_id ?? item.answer_id;
      if (!id) continue;
      out.push({
        url: `${origin}/q/${id}`,
        title: decodeText(item.title ?? "Stack Exchange"),
        via: "stackexchange",
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Wyszukiwarki                                                        */
/* ------------------------------------------------------------------ */

function decodeBingRedirect(url: string): string {
  try {
    const u = new URL(url);
    if (!/bing\.com$/i.test(stripWww(u.hostname))) return url;
    const raw = u.searchParams.get("u");
    if (!raw) return url;
    const payload = raw.startsWith("a1") ? raw.slice(2) : raw;
    const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    return /^https?:\/\//i.test(decoded) ? decoded : url;
  } catch {
    return url;
  }
}

function relevantResult(url: string, title: string, host: string, tokens: string[]): boolean {
  const needles = [host, sld(host), ...tokens].filter((n) => n.length >= 4);
  const blob = `${url} ${title}`.toLowerCase();
  return needles.some((n) => blob.includes(n.toLowerCase()));
}

function pushResult(
  out: Candidate[],
  url: string,
  title: string,
  host: string,
  via: DiscoverySource,
) {
  let clean = unwrapRedirect(decodeBingRedirect(decodeText(url)));
  if (clean.startsWith("//")) clean = `https:${clean}`;
  if (!/^https?:\/\//i.test(clean)) return;
  try {
    clean = normalizeUrl(clean);
  } catch {
    return;
  }
  const h = hostFromUrl(clean);
  if (!h || isTargetHost(h, host) || isJunkHost(h)) return;
  if (isSkippableOutbound(clean, h)) return;
  if (/^(bing|duckduckgo|mojeek|google)\./i.test(stripWww(h))) return;
  if (out.some((c) => c.url === clean)) return;
  out.push({ url: clean, title: title.slice(0, 180) || h, via });
}

/** Bing — parses direct result links, falling back to `<cite>`. */
export async function scanBing(
  host: string,
  tokens: string[],
  signal?: AbortSignal,
): Promise<Candidate[]> {
  const queries = [
    `"${host}" -site:${host}`,
    `link:${host} OR "https://${host}" -site:${host}`,
    ...tokens.slice(0, 2).map((t) => `"${t}" "${host}" -site:${host}`),
  ].slice(0, 3);

  const pages = await Promise.allSettled(
    queries.map(async (query) => {
      const url = `https://www.bing.com/search?count=20&q=${encodeURIComponent(query)}`;
      const { status, text } = await fetchText(url, {
        timeoutMs: 9000,
        maxBytes: 320_000,
        ua: BROWSER_UA,
        signal,
      });
      if (status >= 400) throw new Error(`HTTP ${status}`);
      const out: Candidate[] = [];
      const blocks = text.split(/<li class="b_algo"/i).slice(1);
      for (const block of blocks.slice(0, 20)) {
        const anchor = block.match(
          /<h2[^>]*>[\s\S]{0,400}?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i,
        );
        const title = stripTags(anchor?.[2] ?? "");
        let href = anchor?.[1] ?? "";
        if (!href || /bing\.com\/ck\//i.test(href)) {
          const decoded = decodeBingRedirect(decodeText(href));
          href = decoded !== href ? decoded : "";
        }
        if (!href) {
          const cite = stripTags(block.match(/<cite[^>]*>([\s\S]*?)<\/cite>/i)?.[1] ?? "");
          if (!cite) continue;
          href = cite.replace(/\s*›\s*/g, "/").replace(/\s+/g, "");
          if (!/^https?:\/\//i.test(href)) href = `https://${href.replace(/^\/+/, "")}`;
        }
        if (!relevantResult(href, title, host, tokens)) continue;
        pushResult(out, href, title, host, "bing");
      }
      return out;
    }),
  );
  if (pages.every((p) => p.status === "rejected")) {
    throw new Error("Bing blocked the request");
  }
  const out: Candidate[] = [];
  for (const page of pages) {
    if (page.status !== "fulfilled") continue;
    for (const item of page.value) {
      if (!out.some((c) => c.url === item.url)) out.push(item);
    }
  }
  return out;
}

/** DuckDuckGo — endpoint HTML bez JS. */
export async function scanDuckDuckGo(
  host: string,
  tokens: string[],
  signal?: AbortSignal,
): Promise<Candidate[]> {
  const queries = [
    `"${host}" -site:${host}`,
    ...tokens.slice(0, 1).map((t) => `"${t}" "${host}" -site:${host}`),
  ];
  const pages = await Promise.allSettled(
    queries.map(async (query) => {
      const { status, text } = await fetchText(
        `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
        { timeoutMs: 9000, maxBytes: 320_000, ua: BROWSER_UA, signal },
      );
      if (status >= 400) throw new Error(`HTTP ${status}`);
      const out: Candidate[] = [];
      const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      let match: RegExpExecArray | null;
      while ((match = re.exec(text)) && out.length < 25) {
        const title = stripTags(match[2] ?? "");
        const href = match[1] ?? "";
        if (!relevantResult(href, title, host, tokens)) continue;
        pushResult(out, href, title, host, "duckduckgo");
      }
      return out;
    }),
  );
  if (pages.every((p) => p.status === "rejected")) {
    throw new Error("DuckDuckGo blocked the request");
  }
  const out: Candidate[] = [];
  for (const page of pages) {
    if (page.status !== "fulfilled") continue;
    for (const item of page.value) {
      if (!out.some((c) => c.url === item.url)) out.push(item);
    }
  }
  return out;
}

/** Mojeek — an independent index, a good complement to Bing and DDG. */
export async function scanMojeek(
  host: string,
  tokens: string[],
  signal?: AbortSignal,
): Promise<Candidate[]> {
  const queries = [`"${host}" -site:${host}`, ...tokens.slice(0, 1).map((t) => `"${t}" "${host}"`)];
  const pages = await Promise.allSettled(
    queries.map(async (query) => {
      const { status, text } = await fetchText(
        `https://www.mojeek.com/search?q=${encodeURIComponent(query)}`,
        { timeoutMs: 9000, maxBytes: 320_000, ua: BROWSER_UA, signal },
      );
      if (status >= 400) throw new Error(`HTTP ${status}`);
      const out: Candidate[] = [];
      const re = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]{0,200}?)<\/a>/gi;
      let match: RegExpExecArray | null;
      while ((match = re.exec(text)) && out.length < 25) {
        const href = match[1] ?? "";
        const title = stripTags(match[2] ?? "");
        if (!title || title.length < 3) continue;
        if (!relevantResult(href, title, host, tokens)) continue;
        pushResult(out, href, title, host, "mojeek");
      }
      return out;
    }),
  );
  if (pages.every((p) => p.status === "rejected")) {
    throw new Error("Mojeek unavailable");
  }
  const out: Candidate[] = [];
  for (const page of pages) {
    if (page.status !== "fulfilled") continue;
    for (const item of page.value) {
      if (!out.some((c) => c.url === item.url)) out.push(item);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Media                                                               */
/* ------------------------------------------------------------------ */

function parseRssItems(xml: string): {
  title: string;
  link: string;
  sourceUrl?: string;
  sourceName?: string;
  description?: string;
}[] {
  const items = xml.split(/<item>/i).slice(1);
  return items.slice(0, 40).map((item) => {
    const pick = (re: RegExp) =>
      decodeText((item.match(re)?.[1] ?? "").replace("<![CDATA[", "").replace("]]>", "")).trim();
    return {
      title: pick(/<title>([\s\S]*?)<\/title>/i),
      link: pick(/<link>([\s\S]*?)<\/link>/i),
      description: stripTags(pick(/<description>([\s\S]*?)<\/description>/i)),
      sourceUrl: item.match(/<source[^>]*url="([^"]+)"/i)?.[1],
      sourceName: pick(/<source[^>]*>([\s\S]*?)<\/source>/i),
    };
  });
}

export async function scanNews(
  queries: string[],
  host: string,
  signal?: AbortSignal,
): Promise<{ mentions: Mention[]; candidates: Candidate[] }> {
  const mentions: Mention[] = [];
  const candidates: Candidate[] = [];
  const unique = [...new Set(queries)].slice(0, 2);
  const locales = [
    { hl: "pl", gl: "PL", ceid: "PL:pl" },
    { hl: "en-US", gl: "US", ceid: "US:en" },
  ];
  const jobs = unique.flatMap((q) =>
    locales.map(async (loc) => {
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(
        `"${q}" -site:${host}`,
      )}&hl=${loc.hl}&gl=${loc.gl}&ceid=${loc.ceid}`;
      const { status, text } = await fetchText(url, {
        timeoutMs: 9000,
        maxBytes: 260_000,
        ua: BROWSER_UA,
        accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
        signal,
      });
      if (status >= 400) throw new Error(`HTTP ${status}`);
      return parseRssItems(text);
    }),
  );
  const settled = await Promise.allSettled(jobs);
  if (settled.every((s) => s.status === "rejected")) {
    throw new Error("Google News unavailable");
  }
  const seen = new Set<string>();
  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    for (const item of result.value) {
      const publisherHost = item.sourceUrl ? hostFromUrl(item.sourceUrl) : "";
      if (publisherHost && isTargetHost(publisherHost, host)) continue;
      const sourceUrl = item.sourceUrl || item.link;
      if (!sourceUrl || isTargetHost(hostFromUrl(sourceUrl), host)) continue;
      const blob =
        `${item.title} ${item.link} ${item.sourceName ?? ""} ${item.description ?? ""} ${sourceUrl}`.toLowerCase();
      if (!unique.some((q) => q.length >= 4 && blob.includes(q.toLowerCase()))) {
        continue;
      }
      const key = normalizeUrl(sourceUrl);
      if (seen.has(key)) continue;
      seen.add(key);
      mentions.push(
        makeMention(
          sourceUrl,
          item.title || item.sourceName || "Article",
          item.description?.slice(0, 260) ||
            (item.sourceName ? `${item.sourceName} wspomina ${host}` : "Wzmianka w Google News"),
          "news",
          true,
        ),
      );
      // The publisher's page joins the verification queue — sometimes it really does link.
      candidates.push({
        url: sourceUrl,
        title: item.title || item.sourceName || "Article",
        via: "news",
      });
    }
  }
  return { mentions, candidates };
}

export async function scanGdelt(host: string, signal?: AbortSignal): Promise<Candidate[]> {
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(
    `"${host}"`,
  )}&mode=ArtList&maxrecords=25&format=json`;
  const data = await fetchJson<{
    articles?: { url?: string; title?: string; domain?: string }[];
  }>(url, 9000, API_UA, signal);
  const out: Candidate[] = [];
  for (const article of data.articles ?? []) {
    if (!article.url) continue;
    if (isTargetHost(hostFromUrl(article.url), host)) continue;
    const blob = `${article.title ?? ""} ${article.url}`.toLowerCase();
    if (!blob.includes(host.toLowerCase()) && !blob.includes(sld(host))) continue;
    pushResult(out, article.url, article.title ?? "", host, "news");
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* urlscan.io                                                          */
/* ------------------------------------------------------------------ */

type UrlscanSearch = {
  results?: {
    page?: { url?: string; domain?: string; title?: string };
    task?: { uuid?: string; url?: string };
  }[];
};

export async function scanUrlscan(host: string, signal?: AbortSignal): Promise<Candidate[]> {
  const q = `domain:${host} AND NOT page.domain:${host}`;
  const url = `https://urlscan.io/api/v1/search/?size=30&q=${encodeURIComponent(q)}`;
  const data = await fetchJson<UrlscanSearch>(url, 9000, API_UA, signal);
  const out: Candidate[] = [];
  for (const row of data.results ?? []) {
    const pageUrl = row.page?.url || row.task?.url;
    if (!pageUrl) continue;
    pushResult(out, pageUrl, row.page?.title ?? "", host, "urlscan");
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* GitHub                                                              */
/* ------------------------------------------------------------------ */

type GithubRepo = {
  html_url: string;
  homepage?: string | null;
  full_name?: string;
  description?: string | null;
  stargazers_count?: number;
};
type GithubSearch<T> = { items?: T[] };
type GithubIssue = { html_url: string; title?: string };
type GithubUser = { html_url: string; login?: string };
type GithubCode = { html_url: string; repository?: { full_name?: string } };

export async function scanGithub(
  queries: string[],
  host: string,
  signal?: AbortSignal,
): Promise<{ backlinks: Partial<Backlink>[]; candidates: Candidate[] }> {
  const backlinks: Partial<Backlink>[] = [];
  const candidates: Candidate[] = [];
  const q = queries[0] ?? host;
  const userQ = sld(host);
  const [repos, issues, users, code] = await Promise.allSettled([
    fetchJson<GithubSearch<GithubRepo>>(
      `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=10`,
      9000,
      API_UA,
      signal,
    ),
    fetchJson<GithubSearch<GithubIssue>>(
      `https://api.github.com/search/issues?q=${encodeURIComponent(`${host} in:body`)}&per_page=8`,
      9000,
      API_UA,
      signal,
    ),
    fetchJson<GithubSearch<GithubUser>>(
      `https://api.github.com/search/users?q=${encodeURIComponent(userQ)}&per_page=5`,
      9000,
      API_UA,
      signal,
    ),
    fetchJson<GithubSearch<GithubCode>>(
      `https://api.github.com/search/repositories?q=${encodeURIComponent(`${host} in:readme`)}&per_page=8`,
      9000,
      API_UA,
      signal,
    ),
  ]);

  if (repos.status === "fulfilled") {
    for (const repo of repos.value.items ?? []) {
      const home = repo.homepage ?? "";
      if (home && isTargetHost(hostFromUrl(home), host)) {
        backlinks.push({
          sourceUrl: repo.html_url,
          sourceHost: "github.com",
          sourceDomain: "github.com",
          sourceTitle: repo.full_name || repo.html_url,
          targetUrl: home,
          anchor: repo.full_name || host,
          rel: "nofollow",
          discoveredVia: "github",
          verified: true,
        });
      }
      candidates.push({
        url: repo.html_url,
        title: repo.full_name || "GitHub",
        via: "github",
      });
    }
  }
  if (issues.status === "fulfilled") {
    for (const issue of issues.value.items ?? []) {
      candidates.push({
        url: issue.html_url,
        title: issue.title || "GitHub issue",
        via: "github",
      });
    }
  }
  if (users.status === "fulfilled") {
    for (const user of users.value.items ?? []) {
      candidates.push({
        url: user.html_url,
        title: user.login || "GitHub",
        via: "github",
      });
    }
  }
  if (code.status === "fulfilled") {
    for (const repo of code.value.items ?? []) {
      candidates.push({
        url: repo.html_url,
        title: repo.repository?.full_name || "GitHub README",
        via: "github",
      });
    }
  }
  if (
    repos.status === "rejected" &&
    issues.status === "rejected" &&
    users.status === "rejected" &&
    code.status === "rejected"
  ) {
    throw new Error(
      repos.reason instanceof Error ? repos.reason.message : "GitHub unavailable (API rate limit)",
    );
  }
  return { backlinks, candidates };
}

/* ------------------------------------------------------------------ */
/* Infrastruktura celu: subdomeny, sitemapy, archiwum, Common Crawl    */
/* ------------------------------------------------------------------ */

/** Subdomains from Certificate Transparency — they widen the graph of own pages. */
export async function scanCertSubdomains(domain: string, signal?: AbortSignal): Promise<string[]> {
  const data = await fetchJson<{ name_value?: string }[]>(
    `https://crt.sh/?q=${encodeURIComponent(`%.${domain}`)}&output=json`,
    9000,
    API_UA,
    signal,
  );
  const out = new Set<string>();
  for (const row of data ?? []) {
    for (const name of (row.name_value ?? "").split(/\s+/)) {
      const host = stripWww(name.replace(/^\*\./, "").trim().toLowerCase());
      if (!host || !host.endsWith(domain)) continue;
      if (isJunkHost(host)) continue;
      if (/(^|\.)(mail|smtp|imap|pop|mx|ftp|vpn|cpanel|webmail|autodiscover|_)/.test(host)) {
        continue;
      }
      out.add(host);
      if (out.size >= 25) break;
    }
  }
  return [...out];
}

/** Historical target URLs from Wayback CDX — a source of old outbound links. */
export async function waybackCdxUrls(
  host: string,
  limit = 150,
  signal?: AbortSignal,
): Promise<{ urls: string[]; firstSeen: string | null }> {
  const url = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(
    `${host}/*`,
  )}&output=json&fl=original,timestamp&collapse=urlkey&filter=statuscode:200&filter=mimetype:text/html&limit=${limit}`;
  const rows = await fetchJson<string[][]>(url, 12_000, BROWSER_UA, signal);
  const urls: string[] = [];
  let firstSeen: string | null = null;
  for (const row of rows.slice(1)) {
    const original = row[0];
    const ts = row[1];
    if (original) urls.push(original);
    if (ts && (!firstSeen || ts < firstSeen)) firstSeen = ts;
  }
  return {
    urls,
    firstSeen: firstSeen
      ? `${firstSeen.slice(0, 4)}-${firstSeen.slice(4, 6)}-${firstSeen.slice(6, 8)}`
      : null,
  };
}

/** First appearance of a domain in the archive — an age proxy (a trust signal). */
export async function waybackFirstSeen(host: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const rows = await fetchJson<string[][]>(
      `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(host)}&output=json&fl=timestamp&limit=1&filter=statuscode:200`,
      7000,
      BROWSER_UA,
      signal,
    );
    const ts = rows?.[1]?.[0];
    if (!ts) return null;
    return `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
  } catch {
    return null;
  }
}

/** Target pages visible in Common Crawl — an independent view of indexation. */
export async function scanCommonCrawl(host: string, signal?: AbortSignal): Promise<string[]> {
  const collections = await fetchJson<{ "cdx-api"?: string; id?: string }[]>(
    "https://index.commoncrawl.org/collinfo.json",
    8000,
    API_UA,
    signal,
  );
  const api = collections?.[0]?.["cdx-api"];
  if (!api) throw new Error("Brak indeksu Common Crawl");
  const { status, text } = await fetchText(
    `${api}?url=${encodeURIComponent(`${host}/*`)}&output=json&limit=120&filter=status:200`,
    { timeoutMs: 12_000, maxBytes: 400_000, ua: API_UA, signal },
  );
  if (status >= 400) throw new Error(`HTTP ${status}`);
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { url?: string };
      if (row.url) out.push(row.url);
    } catch {
      /* ignore malformed line */
    }
  }
  return out;
}

/** robots.txt → sitemaps → the target's page URLs. */
export async function fetchSitemapUrls(origin: string, signal?: AbortSignal): Promise<string[]> {
  const seeds: string[] = [];
  try {
    const robots = await fetchText(`${origin}/robots.txt`, {
      timeoutMs: 6000,
      maxBytes: 60_000,
      ua: BROWSER_UA,
      signal,
    });
    if (robots.status < 400) {
      const { parseRobotsSitemaps } = await import("./html.ts");
      seeds.push(...parseRobotsSitemaps(robots.text));
    }
  } catch {
    /* optional */
  }
  for (const guess of ["/sitemap.xml", "/sitemap_index.xml", "/sitemap-index.xml"]) {
    const url = `${origin}${guess}`;
    if (!seeds.includes(url)) seeds.push(url);
  }

  const out: string[] = [];
  const visited = new Set<string>();
  const queue = seeds.slice(0, 6);
  while (queue.length > 0 && out.length < 300 && visited.size < 8) {
    const next = queue.shift()!;
    if (visited.has(next)) continue;
    visited.add(next);
    try {
      const res = await fetchText(next, {
        timeoutMs: 8000,
        maxBytes: 900_000,
        ua: BROWSER_UA,
        accept: "application/xml, text/xml, */*;q=0.8",
        signal,
      });
      if (res.status >= 400 || !/<(urlset|sitemapindex)/i.test(res.text)) continue;
      const locs = parseSitemap(res.text, 300);
      if (/<sitemapindex/i.test(res.text)) {
        for (const loc of locs.slice(0, 4)) queue.push(loc);
        continue;
      }
      out.push(...locs);
    } catch {
      /* ignore */
    }
  }
  return out;
}

export function domainOf(url: string): string {
  return domainFromUrl(url);
}

/* ------------------------------------------------------------------ */
/* Archive of a single page (lost-link detection)          */
/* ------------------------------------------------------------------ */

export type ArchivedPage = { url: string; timestamp: string; date: string };

/** The most recent snapshot of a URL in the Internet Archive. */
export async function waybackSnapshot(
  url: string,
  timeoutMs = 6000,
  signal?: AbortSignal,
): Promise<ArchivedPage | null> {
  try {
    const data = await fetchJson<{
      archived_snapshots?: {
        closest?: { available?: boolean; url?: string; timestamp?: string };
      };
    }>(
      `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`,
      timeoutMs,
      BROWSER_UA,
      signal,
    );
    const closest = data.archived_snapshots?.closest;
    if (!closest?.available || !closest.url || !closest.timestamp) return null;
    const ts = closest.timestamp;
    return {
      url: closest.url.replace(/\/web\/(\d{8,14})\//i, "/web/$1id_/"),
      timestamp: ts,
      date: `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`,
    };
  } catch {
    return null;
  }
}
