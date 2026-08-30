import type { AnchorType, LinkPlacement } from "@/lib/backlinks/types";

export const SOURCE_LABEL: Record<string, string> = {
  wikipedia: "Wikipedia",
  "hacker-news": "Hacker News",
  reddit: "Reddit",
  bluesky: "Bluesky",
  stackexchange: "Stack Exchange",
  bing: "Bing",
  duckduckgo: "DuckDuckGo",
  mojeek: "Mojeek",
  news: "News",
  urlscan: "urlscan",
  github: "GitHub",
  commoncrawl: "Common Crawl",
  graph: "Graph / partner",
  sitemap: "Sitemap",
  archive: "Archive",
  lookup: "Report",
  page: "Deep scan",
};

export const PLACEMENT_LABEL: Record<LinkPlacement, string> = {
  content: "in content",
  navigation: "menu",
  footer: "footer",
  sidebar: "sidebar",
  comment: "comment",
  unknown: "unknown",
};

export const ANCHOR_LABEL: Record<AnchorType, string> = {
  brand: "brand",
  "exact-match": "exact-match",
  url: "URL",
  generic: "generic",
  image: "image",
  empty: "empty",
  "long-tail": "long tail",
};

export const FLAG_LABEL: Record<string, string> = {
  "broken-target": "broken target",
  "noindex-source": "noindex source",
  "page-level-nofollow": "page nofollow",
  boilerplate: "boilerplate",
  sitewide: "sitewide",
  "spam-risk": "spam risk",
  "high-authority": "high authority",
  "image-link": "image link",
  lost: "lost",
  reciprocal: "reciprocal",
  "redirected-target": "redirected target",
  "off-topic": "off-topic",
  "serp-coranker": "co-ranks",
};
