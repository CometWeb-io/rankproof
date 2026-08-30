import type { Backlink, LinkRel } from "@/lib/backlinks/types";

export function relVariant(item: Backlink): "follow" | "nofollow" | "default" {
  if (item.effectiveFollow) return "follow";
  return "nofollow";
}

export function relLabel(rel: LinkRel): string {
  if (rel === "dofollow") return "dofollow";
  if (rel === "sponsored") return "sponsored";
  if (rel === "ugc") return "ugc";
  return "nofollow";
}

export function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function percent(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 100);
}
