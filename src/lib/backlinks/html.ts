import type { AnchorType, LinkPlacement } from "./types.ts";

const SOCIAL_HOST_RE =
  /(?:^|\.)(facebook\.com|instagram\.com|linkedin\.com|x\.com|twitter\.com|youtube\.com|tiktok\.com|threads\.net|github\.com|pinterest\.[a-z.]+|vk\.com|t\.me)$/i;

const GRAPH_PATH_RE =
  /about|kontakt|contact|o-mnie|o_mnie|oferta|offer|uslug|usług|service|portfolio|projekt|project|partner|client|klienci|realizacj|wspolpraca|współpraca|blog|links|blogroll|zespol|zespół|team|bio|cv|autor|author|home|start|praca|works|case|referenc|omnie|press|media|prasa|nagrody|awards|sponsor/i;

const SKIP_INTERNAL_RE =
  /wp-content|wp-admin|wp-json|wp-includes|\/feed|\/comment|\/cart|\/checkout|\/koszyk|\/login|\/account|\/privacy|\/polityka|\/cookie|\/regulamin|\/tag\/|\/category\/|\/kategoria\/|\/page\/\d|\/author\/|#/i;

const GENERIC_ANCHORS = new Set([
  "tutaj",
  "kliknij",
  "kliknij tutaj",
  "zobacz",
  "see more",
  "more",
  "read more",
  "link",
  "strona",
  "www",
  "check",
  "go",
  "open",
  "here",
  "click here",
  "read more",
  "more",
  "this",
  "website",
  "site",
  "learn more",
  "visit",
  "visit site",
  "source",
  "source",
  "external link",
  "homepage",
  "official site",
  "home page",
]);

export function usefulHtml(html: string, maxOut = 240_000): string {
  let i = 0;
  let out = "";
  const n = html.length;
  while (i < n && out.length < maxOut) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out += html.slice(i, i + (maxOut - out.length));
      break;
    }
    if (lt > i) {
      const take = Math.min(lt - i, maxOut - out.length);
      out += html.slice(i, i + take);
      if (out.length >= maxOut) break;
    }
    const lowerHead = html.slice(lt, lt + 12).toLowerCase();
    const skipName = startsWithTag(lowerHead, "style")
      ? "style"
      : startsWithTag(lowerHead, "script")
        ? "script"
        : startsWithTag(lowerHead, "noscript")
          ? "noscript"
          : null;
    if (skipName) {
      const tagEnd = html.indexOf(">", lt);
      if (tagEnd === -1) break;
      const open = html.slice(lt, tagEnd + 1).toLowerCase();
      if (skipName === "script" && open.includes("ld+json")) {
        const close = indexOfCloseTag(html, skipName, tagEnd + 1);
        const end = close === -1 ? n : close;
        const block = html.slice(lt, end);
        const room = maxOut - out.length;
        out += block.slice(0, room);
        i = end;
        continue;
      }
      const close = indexOfCloseTag(html, skipName, tagEnd + 1);
      if (close === -1) break;
      i = close;
      continue;
    }
    const gt = html.indexOf(">", lt);
    if (gt === -1) {
      out += html.slice(lt, lt + (maxOut - out.length));
      break;
    }
    out += html.slice(lt, gt + 1);
    i = gt + 1;
  }
  return out;
}

function startsWithTag(head: string, name: string): boolean {
  if (!head.startsWith(`<${name}`)) return false;
  const c = head.charAt(1 + name.length);
  return c === "" || /[\s>/]/.test(c);
}

function indexOfCloseTag(html: string, name: string, from: number): number {
  const needle = `</${name}`;
  const lower = html.toLowerCase();
  const at = lower.indexOf(needle, from);
  if (at === -1) return -1;
  const gt = html.indexOf(">", at);
  return gt === -1 ? -1 : gt + 1;
}

export function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => safeChar(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => safeChar(parseInt(n, 16)));
}

function safeChar(code: number): string {
  if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

export function decodeText(value: string): string {
  let current = value;
  for (let i = 0; i < 3; i++) {
    const next = decodeEntities(current);
    if (next === current) return next;
    current = next;
  }
  return current;
}

export function stripTags(html: string): string {
  return decodeText(
    html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

/* ------------------------------------------------------------------ */
/* Meta                                                                */
/* ------------------------------------------------------------------ */

/**
 * Attribute bag for a single HTML start tag. Order-independent — `<link href
 * rel>` and `<link rel href>` both work. Values are raw (not entity-decoded).
 */
export function parseTagAttrs(attrText: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re =
    /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(attrText))) {
    const name = (match[1] ?? "").toLowerCase();
    if (!name || name === "/") continue;
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (!(name in out)) out[name] = value;
  }
  return out;
}

function eachTag(
  html: string,
  tagName: string,
  limit: number,
  visit: (attrs: Record<string, string>) => boolean | void,
): void {
  const re = new RegExp(`<${tagName}\\b([^>]*)>`, "gi");
  let match: RegExpExecArray | null;
  let count = 0;
  while ((match = re.exec(html)) && count < limit) {
    count += 1;
    if (visit(parseTagAttrs(match[1] ?? "")) === false) break;
  }
}

export function extractTitle(html: string): string | null {
  let og: string | null = null;
  eachTag(html, "meta", 80, (attrs) => {
    if ((attrs.property ?? "").toLowerCase() === "og:title" && attrs.content) {
      og = decodeText(attrs.content).trim().slice(0, 180);
      return false;
    }
  });
  if (og) return og;
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title?.[1]) {
    return decodeText(title[1].replace(/<[^>]+>/g, ""))
      .trim()
      .slice(0, 180);
  }
  return null;
}

export function extractDescription(html: string): string | null {
  let found: string | null = null;
  eachTag(html, "meta", 80, (attrs) => {
    const name = (attrs.name ?? "").toLowerCase();
    const property = (attrs.property ?? "").toLowerCase();
    const content = attrs.content ?? "";
    if (content.length < 10) return;
    if (name === "description" || property === "og:description") {
      found = decodeText(content).trim().slice(0, 300);
      return false;
    }
  });
  return found;
}

export function extractLang(html: string): string | null {
  const tag = html.match(/<html\b([^>]*)>/i);
  if (tag?.[1]) {
    const lang = parseTagAttrs(tag[1]).lang;
    if (lang) return lang.toLowerCase().split(/[-_]/)[0] ?? null;
  }
  let fromMeta: string | null = null;
  eachTag(html, "meta", 40, (attrs) => {
    if ((attrs["http-equiv"] ?? "").toLowerCase() === "content-language" && attrs.content) {
      fromMeta = attrs.content.toLowerCase().slice(0, 2);
      return false;
    }
  });
  return fromMeta;
}

/**
 * First canonical link href, resolved against `baseUrl` when provided so
 * relative targets like `/produkt` compare cleanly to absolute page URLs.
 */
export function extractCanonical(html: string, baseUrl?: string): string | null {
  // Box avoids a TS control-flow quirk that can narrow closed-over `string | null` to `never`.
  const found: { href: string | null } = { href: null };
  eachTag(html, "link", 60, (attrs) => {
    const rel = (attrs.rel ?? "").toLowerCase().split(/\s+/);
    if (!rel.includes("canonical") || !attrs.href) return;
    found.href = decodeText(attrs.href).trim();
    return false;
  });
  const href = found.href;
  if (!href || href.length < 1) return null;
  if (!baseUrl) return href.slice(0, 500);
  try {
    return new URL(href, baseUrl).href.slice(0, 500);
  } catch {
    return href.slice(0, 500);
  }
}

export type RobotsMeta = { noindex: boolean; nofollow: boolean };

/** Meta robots (+ googlebot). Pair with `parseXRobotsTag` for HTTP headers. */
export function extractRobotsMeta(html: string): RobotsMeta {
  const out: RobotsMeta = { noindex: false, nofollow: false };
  eachTag(html, "meta", 80, (attrs) => {
    const name = (attrs.name ?? "").toLowerCase();
    if (name !== "robots" && name !== "googlebot") return;
    const content = (attrs.content ?? "").toLowerCase();
    if (content.includes("noindex")) out.noindex = true;
    if (content.includes("nofollow")) out.nofollow = true;
    if (content.includes("none")) {
      out.noindex = true;
      out.nofollow = true;
    }
  });
  return out;
}

export function parseXRobotsTag(header: string | null): RobotsMeta {
  const value = (header ?? "").toLowerCase();
  return {
    noindex: value.includes("noindex") || value.includes("none"),
    nofollow: value.includes("nofollow") || value.includes("none"),
  };
}

/* ------------------------------------------------------------------ */
/* Document sections → link placement                             */
/* ------------------------------------------------------------------ */

type Region = { start: number; end: number; kind: LinkPlacement; weight: number };

const SECTION_TAGS: { tag: string; kind: LinkPlacement; weight: number }[] = [
  { tag: "footer", kind: "footer", weight: 3 },
  { tag: "nav", kind: "navigation", weight: 3 },
  { tag: "aside", kind: "sidebar", weight: 2 },
  { tag: "header", kind: "navigation", weight: 1 },
  { tag: "main", kind: "content", weight: 4 },
  { tag: "article", kind: "content", weight: 5 },
];

const CLASS_HINTS: { re: RegExp; kind: LinkPlacement; weight: number }[] = [
  { re: /\b(site-)?footer\b|\bcopyright\b|\bstopka\b/i, kind: "footer", weight: 2 },
  { re: /\bnav(bar|igation)?\b|\bmenu\b|\bbreadcrumb/i, kind: "navigation", weight: 2 },
  { re: /\bsidebar\b|\bwidget\b|\bblogroll\b|\baside\b/i, kind: "sidebar", weight: 2 },
  { re: /\bcomment|\bdisqus|\bkomentarz/i, kind: "comment", weight: 3 },
  {
    re: /\b(post|entry|article|content|main)[-_ ]?(body|content|text)?\b/i,
    kind: "content",
    weight: 3,
  },
];

/**
 * Builds a map of document sections to judge whether a link sits in content,
 * w stopce, w menu, na pasku bocznym czy w komentarzach.
 */
export function buildRegions(html: string): Region[] {
  const regions: Region[] = [];
  const openStack: { kind: LinkPlacement; weight: number; start: number; tag: string }[] = [];
  const re = /<(\/?)([a-z][a-z0-9]*)\b([^>]{0,600})>/gi;
  let match: RegExpExecArray | null;
  let guard = 0;
  while ((match = re.exec(html)) && guard < 20_000) {
    guard += 1;
    const closing = match[1] === "/";
    const tag = (match[2] ?? "").toLowerCase();
    const attrs = match[3] ?? "";
    const section = SECTION_TAGS.find((s) => s.tag === tag);
    const isDivLike = tag === "div" || tag === "section" || tag === "ul" || tag === "ol";
    if (!section && !isDivLike) continue;

    if (!closing && !/\/$/.test(attrs)) {
      let kind: LinkPlacement | null = section?.kind ?? null;
      let weight = section?.weight ?? 0;
      const idClass = `${attrs.match(/class\s*=\s*["']([^"']+)["']/i)?.[1] ?? ""} ${
        attrs.match(/id\s*=\s*["']([^"']+)["']/i)?.[1] ?? ""
      } ${attrs.match(/role\s*=\s*["']([^"']+)["']/i)?.[1] ?? ""}`;
      if (idClass.trim()) {
        for (const hint of CLASS_HINTS) {
          if (hint.re.test(idClass)) {
            if (hint.weight > weight) {
              kind = hint.kind;
              weight = hint.weight;
            }
            break;
          }
        }
      }
      if (!kind) continue;
      openStack.push({ kind, weight, start: match.index, tag });
      continue;
    }

    for (let i = openStack.length - 1; i >= 0; i--) {
      if (openStack[i]!.tag !== tag) continue;
      const open = openStack.splice(i, 1)[0]!;
      regions.push({
        start: open.start,
        end: match.index + match[0].length,
        kind: open.kind,
        weight: open.weight,
      });
      break;
    }
  }
  for (const open of openStack) {
    regions.push({
      start: open.start,
      end: html.length,
      kind: open.kind,
      weight: open.weight,
    });
  }
  return regions;
}

export function placementAt(regions: Region[], index: number): LinkPlacement {
  let best: Region | null = null;
  for (const region of regions) {
    if (index < region.start || index > region.end) continue;
    if (!best) {
      best = region;
      continue;
    }
    const bestSize = best.end - best.start;
    const size = region.end - region.start;
    // A narrower section is more specific; ties are broken by weight.
    if (size < bestSize || (size === bestSize && region.weight > best.weight)) {
      best = region;
    }
  }
  return best?.kind ?? "unknown";
}

/* ------------------------------------------------------------------ */
/* Anchors                                                             */
/* ------------------------------------------------------------------ */

export type ParsedAnchor = {
  href: string;
  rel: string;
  text: string;
  isImage: boolean;
  placement: LinkPlacement;
  index: number;
};

/** Parses `<a>` with its context: image alt, rel and document section. */
export function parseAnchors(
  html: string,
  baseUrl: string,
  opts: { limit?: number; withPlacement?: boolean } = {},
): ParsedAnchor[] {
  const limit = opts.limit ?? 1200;
  const regions = opts.withPlacement === false ? [] : buildRegions(html);
  const out: ParsedAnchor[] = [];
  const re = /<a\b([^>]{0,1200})>/gi;
  let match: RegExpExecArray | null;
  let count = 0;
  while ((match = re.exec(html)) && count < limit) {
    count += 1;
    const attrs = match[1] ?? "";
    const hrefMatch =
      attrs.match(/href\s*=\s*["']([^"']{1,2000})["']/i) ?? attrs.match(/href\s*=\s*([^\s>]+)/i);
    if (!hrefMatch?.[1]) continue;
    const rawHref = decodeText(hrefMatch[1].trim());
    if (
      !rawHref ||
      rawHref.startsWith("#") ||
      /^(javascript|mailto|tel|data|sms|whatsapp):/i.test(rawHref)
    ) {
      continue;
    }
    let href = rawHref;
    try {
      href = new URL(rawHref, baseUrl).href;
    } catch {
      continue;
    }
    href = unwrapRedirect(href);
    try {
      href = new URL(href).href;
    } catch {
      continue;
    }
    const relMatch = attrs.match(/rel\s*=\s*["']([^"']+)["']/i);
    const afterStart = match.index + match[0].length;
    const after = html.slice(afterStart, afterStart + 600);
    const close = after.search(/<\s*\/\s*a\s*>/i);
    const inner = close >= 0 ? after.slice(0, close) : after.slice(0, 200);
    const imgAlt = inner.match(/<img[^>]+alt\s*=\s*["']([^"']{1,140})["']/i)?.[1] ?? "";
    const isImage = /<img\b/i.test(inner);
    const rawText = decodeText(inner.replace(/<[^>]+>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
    const ariaLabel = attrs.match(/aria-label\s*=\s*["']([^"']{1,140})["']/i)?.[1];
    const titleAttr = attrs.match(/title\s*=\s*["']([^"']{1,140})["']/i)?.[1];
    const text = (rawText || decodeText(imgAlt) || ariaLabel || titleAttr || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);
    out.push({
      href,
      rel: relMatch?.[1] ?? "",
      text,
      isImage,
      index: match.index,
      placement: regions.length > 0 ? placementAt(regions, match.index) : "unknown",
    });
  }
  return out;
}

/** Rozpakowuje popularne przekierowania (archiwum, Google, Bing, DDG). */
export function unwrapRedirect(url: string): string {
  const archive = url.match(/\/web\/\d{8,14}\*??(?:[a-z]{2}_)?\/(https?:\/\/\S+)/i);
  if (archive?.[1]) return archive[1];
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./i, "");
    const paramKeys = ["uddg", "url", "u", "q", "target", "to", "redirect"];
    if (
      /^(duckduckgo\.com|google\.[a-z.]+|bing\.com|out\.reddit\.com|l\.facebook\.com|t\.umblr\.com|href\.li|steamcommunity\.com)$/i.test(
        host,
      ) ||
      /\/(url|redirect|out|away|link)\b/i.test(u.pathname)
    ) {
      for (const key of paramKeys) {
        const value = u.searchParams.get(key);
        if (value && /^https?:\/\//i.test(value)) return value;
      }
    }
  } catch {
    /* ignore */
  }
  return url;
}

export function classifyAnchor(
  text: string,
  targetHost: string,
  brandTokens: string[],
  isImage: boolean,
): AnchorType {
  const value = text.trim().toLowerCase();
  if (!value) return isImage ? "image" : "empty";
  if (isImage && value.length < 4) return "image";
  const bare = value.replace(/^https?:\/\//, "").replace(/^www\./, "");
  const host = targetHost.toLowerCase();
  if (bare.startsWith(host) || value.includes(host)) return "url";
  if (brandTokens.some((token) => token.length >= 4 && value.includes(token.toLowerCase()))) {
    return "brand";
  }
  if (GENERIC_ANCHORS.has(value)) return "generic";
  const words = value.split(/\s+/).filter(Boolean).length;
  if (words >= 5) return "long-tail";
  return "exact-match";
}

/* ------------------------------------------------------------------ */
/* URL discovery                                                  */
/* ------------------------------------------------------------------ */

export function extractRelMe(html: string): string[] {
  const out: string[] = [];
  const re = /<(?:a|link)\b([^>]{0,800}rel\s*=\s*["'][^"']*\bme\b[^"']*["'][^>]{0,800})>/gi;
  let match: RegExpExecArray | null;
  let count = 0;
  while ((match = re.exec(html)) && count < 40) {
    count += 1;
    const href = match[1]?.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
    if (href) out.push(href);
  }
  return out;
}

export function extractJsonLdUrls(html: string): string[] {
  const out: string[] = [];
  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]{0,80000}?)<\/script>/gi;
  let match: RegExpExecArray | null;
  let count = 0;
  while ((match = re.exec(html)) && count < 12) {
    count += 1;
    const raw = (match[1] ?? "").trim();
    if (!raw) continue;
    try {
      walkLd(JSON.parse(raw), out, 0);
    } catch {
      /* ignore broken json-ld */
    }
  }
  return out;
}

function walkLd(node: unknown, out: string[], depth: number) {
  if (depth > 8 || node == null) return;
  if (Array.isArray(node)) {
    for (const item of node) walkLd(item, out, depth + 1);
    return;
  }
  if (typeof node !== "object") return;
  const rec = node as Record<string, unknown>;
  for (const key of [
    "sameAs",
    "codeRepository",
    "discussionUrl",
    "isPartOf",
    "publisher",
    "sponsor",
    "memberOf",
    "citation",
    "subjectOf",
  ]) {
    pushLdUrls(rec[key], out);
  }
  for (const value of Object.values(rec)) {
    if (value && typeof value === "object") walkLd(value, out, depth + 1);
  }
}

function pushLdUrls(value: unknown, out: string[]) {
  if (typeof value === "string" && /^https?:\/\//i.test(value)) {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) pushLdUrls(item, out);
    return;
  }
  if (value && typeof value === "object") {
    const url = (value as Record<string, unknown>).url;
    if (typeof url === "string" && /^https?:\/\//i.test(url)) out.push(url);
  }
}

export function isUsefulInternalPath(path: string): boolean {
  if (!path || path === "/") return false;
  if (SKIP_INTERNAL_RE.test(path)) return false;
  const last = path.split("/").filter(Boolean).at(-1) ?? "";
  if (
    /\.(?:jpg|jpeg|png|gif|webp|avif|svg|pdf|zip|css|js|xml|json|woff2?|mp4|mp3|ico)$/i.test(last)
  ) {
    return false;
  }
  return path.length > 1 && path.length < 160;
}

export function scoreInternalPath(path: string): number {
  let score = 1;
  if (GRAPH_PATH_RE.test(path)) score += 6;
  if (/portfolio|projekt|project|realizacj|klienci|partner|sponsor|press|media/.test(path)) {
    score += 4;
  }
  if (/blog|poradnik|news|artyk|case/.test(path)) score += 2;
  const depth = path.split("/").filter(Boolean).length;
  if (depth === 1) score += 2;
  if (depth > 3) score -= 2;
  return score;
}

export function isSocialHost(host: string): boolean {
  return SOCIAL_HOST_RE.test(host);
}

export function rssItemLinks(xml: string): string[] {
  const items = xml.split(/<(?:item|entry)[\s>]/i).slice(1);
  const out: string[] = [];
  for (const item of items.slice(0, 40)) {
    const link = (item.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1] ?? "")
      .replace("<![CDATA[", "")
      .replace("]]>", "")
      .trim();
    if (link) {
      out.push(decodeText(link));
      continue;
    }
    const atom = item.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1];
    if (atom) out.push(decodeText(atom));
  }
  return out;
}

export function extractAlternateRss(html: string): string[] {
  const out: string[] = [];
  const re = /<link\b([^>]{0,500})>/gi;
  let match: RegExpExecArray | null;
  let count = 0;
  while ((match = re.exec(html)) && count < 60) {
    count += 1;
    const attrs = match[1] ?? "";
    if (!/rel\s*=\s*["'][^"']*alternate[^"']*["']/i.test(attrs)) continue;
    if (!/type\s*=\s*["']application\/(?:rss|atom)\+xml["']/i.test(attrs)) continue;
    const href = attrs.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
    if (href) out.push(decodeText(href));
  }
  return out;
}

/** `<loc>` URLs from a sitemap (works for sitemapindex too). */
export function parseSitemap(xml: string, limit = 400): string[] {
  const out: string[] = [];
  const re = /<loc>\s*([\s\S]{4,600}?)\s*<\/loc>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) && out.length < limit) {
    const value = decodeText((match[1] ?? "").replace("<![CDATA[", "").replace("]]>", "")).trim();
    if (/^https?:\/\//i.test(value)) out.push(value);
  }
  return out;
}

export function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex\b/i.test(xml);
}

/** Adresy sitemap z robots.txt. */
export function parseRobotsSitemaps(text: string): string[] {
  const out: string[] = [];
  const re = /^\s*sitemap:\s*(\S+)\s*$/gim;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) && out.length < 12) {
    if (match[1] && /^https?:\/\//i.test(match[1])) out.push(match[1]);
  }
  return out;
}

/** A slice of text around a mention — real context instead of boilerplate. */
export function snippetAround(html: string, needle: string, radius = 140): string | null {
  const text = stripTags(html);
  const at = text.toLowerCase().indexOf(needle.toLowerCase());
  if (at === -1) return null;
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + needle.length + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

/* ------------------------------------------------------------------ */
/* On-page / SERP extractors                                           */
/* ------------------------------------------------------------------ */

export function extractHeadings(html: string, tag: "h1" | "h2" | "h3", limit = 8): string[] {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) && out.length < limit) {
    const text = stripTags(match[1] ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 140);
    if (text.length >= 2 && !out.includes(text)) out.push(text);
  }
  return out;
}

export function extractOg(html: string): { title: string | null; image: boolean } {
  let title: string | null = null;
  let image = false;
  eachTag(html, "meta", 80, (attrs) => {
    const property = (attrs.property ?? "").toLowerCase();
    if (property === "og:title" && attrs.content && !title) {
      title = decodeText(attrs.content).trim().slice(0, 180);
    }
    if (property === "og:image" && (attrs.content ?? "").length >= 8) image = true;
  });
  return { title, image };
}

export function extractSchemaTypes(html: string, limit = 8): string[] {
  const out: string[] = [];
  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]{0,80000}?)<\/script>/gi;
  let match: RegExpExecArray | null;
  let count = 0;
  while ((match = re.exec(html)) && count < 12) {
    count += 1;
    try {
      collectSchemaTypes(JSON.parse((match[1] ?? "").trim()), out, 0);
    } catch {
      /* ignore */
    }
  }
  return [...new Set(out)].slice(0, limit);
}

function collectSchemaTypes(node: unknown, out: string[], depth: number) {
  if (depth > 6 || node == null) return;
  if (Array.isArray(node)) {
    for (const item of node) collectSchemaTypes(item, out, depth + 1);
    return;
  }
  if (typeof node !== "object") return;
  const rec = node as Record<string, unknown>;
  const type = rec["@type"];
  if (typeof type === "string" && type.length >= 2 && type.length <= 60) out.push(type);
  else if (Array.isArray(type)) {
    for (const item of type) {
      if (typeof item === "string" && item.length >= 2 && item.length <= 60) out.push(item);
    }
  }
  for (const value of Object.values(rec)) {
    if (value && typeof value === "object") collectSchemaTypes(value, out, depth + 1);
  }
}

export function countWords(html: string): number {
  const text = stripTags(html);
  if (!text) return 0;
  return text.split(/\s+/).filter((w) => w.length >= 2).length;
}

export function countLinks(
  html: string,
  baseUrl: string,
  host: string,
): { internal: number; external: number } {
  const anchors = parseAnchors(html, baseUrl, { limit: 400, withPlacement: false });
  let internal = 0;
  let external = 0;
  const target = host.replace(/^www\./i, "").toLowerCase();
  for (const a of anchors) {
    let h = "";
    try {
      h = new URL(a.href).hostname.replace(/^www\./i, "").toLowerCase();
    } catch {
      continue;
    }
    if (!h) continue;
    if (h === target || h.endsWith(`.${target}`)) internal += 1;
    else external += 1;
  }
  return { internal, external };
}

