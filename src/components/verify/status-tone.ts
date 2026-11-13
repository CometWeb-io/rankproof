import type { ContractVerdict } from "@/lib/backlinks/observe";

/** Text colour per result; dots and chips take `currentColor` from it. */
export const VERDICT_TONE: Record<ContractVerdict, string> = {
  meets: "text-follow",
  deviates: "text-nofollow",
  missing: "text-danger",
  unverified: "text-muted",
};

/** Bar fill per result, for the distribution strip. */
export const VERDICT_FILL: Record<ContractVerdict, string> = {
  meets: "bg-follow",
  deviates: "bg-nofollow",
  missing: "bg-danger",
  unverified: "bg-subtle/60",
};

export const VERDICT_HELP: Record<ContractVerdict, string> = {
  meets: "Exact target URL linked, and every stated clause holds.",
  deviates: "Linked, but the anchor or rel differs from what was agreed.",
  missing: "No anchor to the exact target URL in the fetched HTML.",
  unverified: "The page could not be read. Not evidence of a missing link.",
};
