import { ICANN_RULES, PRIVATE_RULES } from "./public-suffix-data.ts";

function asciiHost(host: string): string {
  const clean = host.trim().toLowerCase().replace(/\.$/, "");
  if (!clean) return "";
  try {
    return new URL(`https://${clean}`).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return clean;
  }
}

type Rules = { exact: Set<string>; wildcard: Set<string>; exception: Set<string> };
let cached: Rules | null = null;

function rules(): Rules {
  if (cached) return cached;
  const exact = new Set<string>();
  const wildcard = new Set<string>();
  const exception = new Set<string>();
  for (const rule of (ICANN_RULES + "\n" + PRIVATE_RULES).split("\n")) {
    if (!rule) continue;
    const ex = rule.startsWith("!");
    const wc = rule.startsWith("*.");
    const ascii = asciiHost(rule.slice(ex ? 1 : wc ? 2 : 0));
    if (!ascii) continue;
    if (ex) exception.add(ascii);
    else if (wc) wildcard.add(ascii);
    else exact.add(ascii);
  }
  cached = { exact, wildcard, exception };
  return cached;
}

/** PSL wildcard, longest-match and exception semantics. Private suffixes
 * (github.io, blogspot.com etc.) are included for tenant isolation. */
export function publicSuffix(host: string): string {
  const h = asciiHost(host);
  if (!h || h.includes(":") || /^\d+(?:\.\d+){3}$/.test(h)) return "";
  const labels = h.split(".");
  const set = rules();
  let suffixLength = 1; // PSL implicit "*".
  for (let i = 0; i < labels.length; i++) {
    const candidate = labels.slice(i).join(".");
    const count = labels.length - i;
    if (set.exception.has(candidate)) {
      return labels.slice(-(count - 1)).join(".");
    }
    if (set.exact.has(candidate)) suffixLength = Math.max(suffixLength, count);
    // A wildcard rule "*.parent" covers exactly one extra label.
    if (i + 1 < labels.length && set.wildcard.has(labels.slice(i + 1).join("."))) {
      suffixLength = Math.max(suffixLength, count);
    }
  }
  return labels.slice(-suffixLength).join(".");
}

/** Returns eTLD+1. A public suffix by itself has no registrable domain. */
export function registeredDomain(host: string): string {
  const h = asciiHost(host);
  const suffix = publicSuffix(h);
  if (!h || !suffix || h === suffix) return "";
  const labels = h.split(".");
  const suffixLabels = suffix.split(".").length;
  return labels.slice(-(suffixLabels + 1)).join(".");
}
