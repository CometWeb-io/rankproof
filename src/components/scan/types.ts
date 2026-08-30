export type Tab =
  | "overview"
  | "plan"
  | "performance"
  | "structure"
  | "serp"
  | "keywords"
  | "links"
  | "domains"
  | "pages"
  | "anchors"
  | "toxic"
  | "outbound"
  | "gap"
  | "prospects"
  | "mentions"
  | "issues"
  | "sources";

export type LinkFilter =
  | "all"
  | "dofollow"
  | "nofollow"
  | "content"
  | "authority"
  | "ontopic"
  | "risk"
  | "broken"
  | "lost"
  | "new";

export type SortKey = "score" | "authority" | "relevance" | "domain" | "recent";

export type TabItem = readonly [Tab, string, number];
