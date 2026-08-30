import type { KeywordIdea, KeywordIntent, KeywordStat, SerpEngine, SerpProspect } from "@/lib/backlinks/types";

export const REASON_LABEL: Record<SerpProspect["reason"], string> = {
  "serp-coranker": "co-ranks, does not link",
  "unlinked-mention": "unlinked mention",
  "lost-link": "lost link",
};

export const KEYWORD_SOURCE_LABEL: Record<KeywordStat["source"], string> = {
  title: "title",
  h1: "H1",
  meta: "meta",
  content: "content",
  anchor: "anchor",
  brand: "brand",
};

export const INTENT_LABEL: Record<KeywordIntent, string> = {
  brand: "brand",
  informational: "informational",
  commercial: "commercial",
  transactional: "transactional",
  navigational: "navigational",
  local: "local",
};

export const FEATURE_LABEL: Record<string, string> = {
  featured: "featured snippet",
  paa: "people also ask",
  knowledge: "knowledge panel",
  news: "news",
  video: "video",
  images: "images",
  ads: "ads",
  shopping: "shopping",
  local: "local / maps",
  sitelinks: "sitelinks",
  discussions: "forums & discussions",
};

export const ENGINE_OPTIONS: { id: SerpEngine; label: string }[] = [
  { id: "bing", label: "Bing" },
  { id: "duckduckgo", label: "DuckDuckGo" },
  { id: "mojeek", label: "Mojeek" },
  { id: "brave", label: "Brave" },
  { id: "google", label: "Google (provider)" },
];

export const IDEA_SOURCE_LABEL: Record<KeywordIdea["source"], string> = {
  autocomplete: "autocomplete",
  related: "related",
  question: "question",
  modifier: "modifier",
};
