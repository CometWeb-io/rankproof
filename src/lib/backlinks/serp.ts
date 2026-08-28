import { decodeText, stripTags, unwrapRedirect } from "./html.ts";
import { hostFromUrl, isTargetHost, registrableDomain, stripWww } from "./parse.ts";
import { positionCtr } from "./serp-intel.ts";
import { domainScore } from "./score.ts";
import type { SerpEngine, SerpFeature, SerpHit, SerpStatus } from "./types.ts";

export type OrganicHit = {
  position: number;
  url: string;
  title: string;
  snippet: string;
};

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

function cleanUrl(raw: string): string | null {
  // Order matters: DuckDuckGo emits its redirect wrapper protocol-relative
  // (`//duckduckgo.com/l/?uddg=…`). unwrapRedirect parses with `new URL()`,
  // which throws on a scheme-less URL, so the scheme has to go on first —
  // otherwise every wrapped result is later discarded as a duckduckgo.com link.
  let href = decodeText(raw);
  if (href.startsWith("//")) href = `https:${href}`;
  href = unwrapRedirect(decodeBingRedirect(href));
  if (href.startsWith("//")) href = `https:${href}`;
  if (!/^https?:\/\//i.test(href)) {
    if (/^[a-z0-9.-]+\.[a-z]{2,}/i.test(href)) href = `https://${href}`;
    else return null;
  }
  try {
    const u = new URL(href);
    if (
      /^(bing|duckduckgo|mojeek|google|microsoft|brave|search\.brave|r\.search)\./i.test(
        stripWww(u.hostname),
      )
    ) {
      return null;
    }
    return u.href;
  } catch {
    return null;
  }
}

function pushHit(out: OrganicHit[], url: string, title: string, snippet: string) {
  const clean = cleanUrl(url);
  if (!clean) return;
  if (out.some((h) => h.url === clean)) return;
  const t = stripTags(title).slice(0, 180);
  if (!t) return;
  out.push({
    position: out.length + 1,
    url: clean,
    title: t,
    snippet: stripTags(snippet).slice(0, 220),
  });
}

/** Parses Bing organic results (the JS-free HTML page). */
export function parseBingOrganic(html: string): OrganicHit[] {
  const out: OrganicHit[] = [];
  const blocks = html.split(/<li class="b_algo"/i).slice(1);
  for (const block of blocks.slice(0, 24)) {
    const anchor = block.match(/<h2[^>]*>[\s\S]{0,400}?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
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
    const snippet = stripTags(
      block.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] ??
        block.match(/class="b_caption"[^>]*>([\s\S]{0,400})/i)?.[1] ??
        "",
    );
    pushHit(out, href, title, snippet);
  }
  return out;
}

export function parseDdgOrganic(html: string): OrganicHit[] {
  const out: OrganicHit[] = [];
  const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) && out.length < 24) {
    const href = match[1] ?? "";
    const title = stripTags(match[2] ?? "");
    const after = html.slice(match.index, match.index + 900);
    const snippet = stripTags(after.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? "");
    pushHit(out, href, title, snippet);
  }
  return out;
}

export function parseMojeekOrganic(html: string): OrganicHit[] {
  const out: OrganicHit[] = [];
  // Split on the result title class. A two-result page is a valid page, so
  // there is no minimum-block guard here.
  const blocks = html.split(/class="[^"]*title[^"]*"/i).slice(1);
  for (const block of blocks.slice(0, 24)) {
    const anchor = block.match(/href="(https?:\/\/[^"]+)"[^>]*>([\s\S]{0,200}?)<\/a>/i);
    if (!anchor) continue;
    const snippet = stripTags(block.match(/class="[^"]*s[nt]p[^"]*"[^>]*>([\s\S]{0,300})/i)?.[1] ?? "");
    pushHit(out, anchor[1] ?? "", stripTags(anchor[2] ?? ""), snippet);
  }
  // Deliberately no generic "any anchor" fallback. When the result markup
  // changes, header, nav and footer links would become fabricated organic
  // results with invented positions — and detectSerpBlock would then call the
  // page "ok". An empty list is reported as parser-failed, which is the truth.
  return out;
}

/** Brave Search — its own index, a good complement to Bing and DDG. */
export function parseBraveOrganic(html: string): OrganicHit[] {
  const out: OrganicHit[] = [];
  const blocks = html.split(/<(?:div|a)[^>]+class="[^"]*snippet[^"]*"/i).slice(1);
  for (const block of blocks.slice(0, 24)) {
    const href =
      block.match(/href="(https?:\/\/[^"]+)"/i)?.[1] ??
      block.match(/<a[^>]+href="(\/\/[^"]+)"/i)?.[1] ??
      "";
    if (!href) continue;
    const title = stripTags(
      block.match(/class="[^"]*(?:snippet-title|title)[^"]*"[^>]*>([\s\S]{0,300}?)</i)?.[1] ??
        block.match(/<span[^>]*>([\s\S]{0,200}?)<\/span>/i)?.[1] ??
        "",
    );
    const snippet = stripTags(
      block.match(/class="[^"]*snippet-description[^"]*"[^>]*>([\s\S]{0,400}?)</i)?.[1] ?? "",
    );
    pushHit(out, href, title, snippet);
  }
  return out;
}

/** Related searches from the bottom of the SERP — a free keyword source. */
export function parseRelatedSearches(html: string, engine: SerpEngine): string[] {
  const out: string[] = [];
  const push = (raw: string) => {
    const value = stripTags(decodeText(raw)).replace(/\s+/g, " ").trim().toLowerCase();
    if (value.length < 3 || value.length > 70) return;
    if (/^(https?:|www\.)/i.test(value)) return;
    if (out.includes(value) || out.length >= 12) return;
    out.push(value);
  };

  if (engine === "bing") {
    const section = html.match(/id="brsv3"[\s\S]{0,6000}/i)?.[0] ?? html;
    for (const m of section.matchAll(/<a[^>]+href="\/search\?q=([^"&]+)[^"]*"[^>]*>([\s\S]{0,120}?)<\/a>/gi)) {
      push(m[2] || decodeURIComponent(m[1] ?? ""));
    }
  } else if (engine === "duckduckgo") {
    for (const m of html.matchAll(/class="[^"]*related-searches?[^"]*"[\s\S]{0,200}?>([^<]{3,70})</gi)) {
      push(m[1] ?? "");
    }
  } else if (engine === "brave") {
    for (const m of html.matchAll(/data-query="([^"]{3,70})"/gi)) push(m[1] ?? "");
  }

  if (out.length === 0) {
    for (const m of html.matchAll(/[?&]q=([^"&#]{3,80})"[^>]*>(?:<[^>]+>)*([^<]{3,70})</gi)) {
      push(m[2] ?? "");
    }
  }
  return out;
}

/** "People also ask" questions from the SERP — ready-made content headings. */
export function parsePeopleAlsoAsk(html: string): string[] {
  const out: string[] = [];
  const QUESTION =
    /(?:^|>)\s*((?:jak|co|czy|ile|gdzie|kiedy|dlaczego|który|która|ktore|które|what|how|why|when|where|which|who|is|are|does|do)\b[^<>?]{6,110}\?)/gi;
  for (const m of html.matchAll(QUESTION)) {
    const value = stripTags(decodeText(m[1] ?? "")).replace(/\s+/g, " ").trim();
    if (value.length < 10 || value.length > 120) continue;
    const key = value.toLowerCase();
    if (out.some((item) => item.toLowerCase() === key)) continue;
    out.push(value);
    if (out.length >= 10) break;
  }
  return out;
}

/**
 * Tells apart "no results" from "we were blocked" and from "the parser broke".
 *
 * Without this, a CAPTCHA page and a genuinely empty SERP both produce zero
 * hits — and the user reads "visibility 0" as a fact about their site rather
 * than a failure of the measurement.
 */
/**
 * Bot-challenge markers. Engines rarely say "captcha" any more: DuckDuckGo
 * serves an `anomaly-modal` puzzle, Mojeek asks for JavaScript, Cloudflare
 * has its own wording. Every one of these must read as "blocked", because
 * calling a challenge page a parser bug sends people to file bogus issues.
 */
const CHALLENGE =
  /captcha|are you a robot|unusual traffic|unusual activity|verify you are human|nie jestes robotem|automated queries|challenge-platform|cf-browser-verification|anomaly-modal|anomaly_modal|javascript is required to complete this challenge|enable javascript and cookies to continue|please enable (?:js|javascript) and disable any ad ?blocker|our systems have detected|blocked by network security/;

export function detectSerpBlock(html: string, hits: number, httpStatus?: number): SerpStatus {
  // Results on the page settle it: this tool's own audience searches for
  // "captcha" and "unusual traffic", and those words in a snippet must not
  // turn a working SERP into a reported block.
  if (hits > 0) return "ok";
  const blob = html.slice(0, 40_000).toLowerCase();
  if (CHALLENGE.test(blob)) return "blocked";
  // A search endpoint answering 202/204 is never a real result page — it is
  // the shape engines use to hand back an interstitial.
  if (hits === 0 && (httpStatus === 202 || httpStatus === 204)) return "blocked";
  if (!html || html.length < 300) return "empty-response";
  if (/rate limit|too many requests|429/.test(blob)) return "rate-limited";
  // A full-length page that yields nothing usually means the markup moved.
  if (/no results|brak wyników|did not match any/.test(blob)) return "no-results";
  return html.length > 20_000 ? "parser-failed" : "no-results";
}

export function detectSerpFeatures(html: string, engine: SerpEngine): SerpFeature[] {
  const features = new Set<SerpFeature>();
  const blob = html.slice(0, 120_000).toLowerCase();
  const add = (feature: SerpFeature, test: boolean) => {
    if (test) features.add(feature);
  };

  // Signals common to every engine.
  add("paa", /people also ask|ludzie pytają|b_rich|df_qna|related-questions/.test(blob));
  add("knowledge", /knowledge|infobox|b_entityTP|wikipedia\.org\/wiki/.test(blob));
  add("sitelinks", /b_vlist2col|deep-?links|sitelink/.test(blob));
  add("discussions", /reddit\.com|quora\.com|forum/.test(blob));
  add("shopping", /shopping|b_pag_prod|pla_|product-?grid/.test(blob));
  add("local", /maps|b_localmap|local-?pack|adres/.test(blob));

  if (engine === "bing") {
    add("featured", /b_ans|b_capgn_tab|featured snippet|b_snippet/.test(blob));
    add("news", /b_nws|news_dt/.test(blob));
    add("ads", /b_ads|b_adlabel|class="b_ad/.test(blob));
    add("images", /b_img|mimg/.test(blob));
    add("video", /b_vid|videoiq|mv_vid/.test(blob));
  } else if (engine === "duckduckgo") {
    add("ads", /result--ad|badge--ad/.test(blob));
    add("news", /module--news|result--news/.test(blob));
    add("images", /module--images|tile--img/.test(blob));
    add("video", /module--videos|result--vid/.test(blob));
  } else if (engine === "brave") {
    add("featured", /class="[^"]*(?:answer|infobox)/.test(blob));
    add("news", /data-type="news"/.test(blob));
    add("video", /data-type="videos?"/.test(blob));
    add("images", /data-type="images?"/.test(blob));
  } else {
    add("featured", /featured|knowledge/.test(blob));
  }
  return [...features];
}

export function toSerpHits(hits: OrganicHit[], targetHost: string): SerpHit[] {
  return hits.map((hit) => {
    const host = hostFromUrl(hit.url);
    return {
      position: hit.position,
      url: hit.url,
      host,
      domain: registrableDomain(host),
      title: hit.title,
      snippet: hit.snippet,
      isTarget: isTargetHost(host, targetHost),
      domainScore: domainScore({ host, https: hit.url.startsWith("https://") }),
      ctr: positionCtr(hit.position),
    };
  });
}

/** Merges results from consecutive SERP pages, preserving position order. */
export function mergePages(pages: OrganicHit[][]): OrganicHit[] {
  const out: OrganicHit[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    for (const hit of page) {
      if (seen.has(hit.url)) continue;
      seen.add(hit.url);
      out.push({ ...hit, position: out.length + 1 });
    }
  }
  return out;
}

export function targetPosition(hits: SerpHit[]): number | null {
  const found = hits.find((hit) => hit.isTarget);
  return found ? found.position : null;
}
