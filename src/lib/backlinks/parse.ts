const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/i;

/**
 * A shortened list of multi-part public suffixes (a subset of the Public Suffix
 * List). It lets us count referring domains correctly for `company.com.pl` or
 * `shop.co.uk`, where naively taking the last two labels gives the wrong answer.
 */
const MULTI_SUFFIXES = new Set([
  "com.pl",
  "net.pl",
  "org.pl",
  "edu.pl",
  "gov.pl",
  "info.pl",
  "biz.pl",
  "waw.pl",
  "krakow.pl",
  "wroclaw.pl",
  "poznan.pl",
  "gda.pl",
  "lodz.pl",
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "me.uk",
  "net.uk",
  "sch.uk",
  "com.au",
  "net.au",
  "org.au",
  "edu.au",
  "gov.au",
  "id.au",
  "co.nz",
  "net.nz",
  "org.nz",
  "govt.nz",
  "ac.nz",
  "co.jp",
  "ne.jp",
  "or.jp",
  "ac.jp",
  "go.jp",
  "com.br",
  "net.br",
  "org.br",
  "gov.br",
  "edu.br",
  "com.cn",
  "net.cn",
  "org.cn",
  "gov.cn",
  "edu.cn",
  "co.in",
  "net.in",
  "org.in",
  "gov.in",
  "ac.in",
  "com.mx",
  "com.ar",
  "com.tr",
  "com.tw",
  "com.hk",
  "com.sg",
  "com.my",
  "com.ua",
  "co.za",
  "org.za",
  "co.il",
  "com.es",
  "com.pt",
  "com.ru",
  "co.kr",
  "or.kr",
  "ne.kr",
  "go.kr",
  "gov.it",
  "edu.it",
  "gov.gr",
  "com.gr",
  "edu.gr",
  "org.gr",
  "gov.cz",
  "gov.sk",
  "gov.hu",
  "gov.ro",
  "gov.rs",
]);

/** Tracking parameters — stripped during normalisation to avoid duplicates. */
const TRACKING_PARAM_RE =
  /^(utm_[a-z_]+|fbclid|gclid|gbraid|wbraid|msclkid|mc_[a-z]+|igshid|yclid|_ga|_gl|ref|ref_src|referrer|source|si|spm|trk|trk_[a-z]+|at_[a-z]+|cmpid|campaign|feature|share|__hstc|__hssc|hsa_[a-z]+|vero_[a-z]+|pk_[a-z]+|piwik_[a-z]+|sc_[a-z]+)$/i;

export type ParsedTarget = {
  host: string;
  domain: string;
  wwwHost: string;
  url: string;
  /** The path supplied by the user (when they pointed at a specific page). */
  path: string;
};

export function stripWww(host: string): string {
  return host.replace(/^www\./i, "").toLowerCase();
}

/** eTLD+1, np. `blog.sklep.com.pl` -> `sklep.com.pl`. */
export function registrableDomain(host: string): string {
  const h = stripWww(host).replace(/\.$/, "");
  if (!h || !h.includes(".")) return h;
  const labels = h.split(".");
  if (labels.length <= 2) return h;
  const lastTwo = labels.slice(-2).join(".");
  if (MULTI_SUFFIXES.has(lastTwo) && labels.length >= 3) {
    return labels.slice(-3).join(".");
  }
  return lastTwo;
}

export function tldOf(host: string): string {
  const parts = stripWww(host).split(".");
  const lastTwo = parts.slice(-2).join(".");
  if (MULTI_SUFFIXES.has(lastTwo)) return lastTwo;
  return parts.at(-1) ?? "";
}

/** Etykieta marki: `sklep` z `sklep.com.pl`. */
export function sld(host: string): string {
  const domain = registrableDomain(host);
  const first = domain.split(".")[0];
  return first || stripWww(host);
}

export function parseTarget(raw: string): ParsedTarget {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Enter a site address or domain.");
  }
  if (/\s/.test(trimmed) || /[<>"]/.test(trimmed)) {
    throw new Error("The address contains characters that are not allowed.");
  }

  let host = "";
  let url = "";
  let path = "/";

  try {
    const withProto = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const parsed = new URL(withProto);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Only http(s) addresses are supported.");
    }
    host = stripWww(parsed.hostname);
    path = parsed.pathname || "/";
    url = `https://${host}`;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Only http")) {
      throw err;
    }
    throw new Error("That address could not be read. Try something like nasa.gov");
  }

  if (!HOST_RE.test(host)) {
    throw new Error("That does not look like a domain name.");
  }

  return {
    host,
    domain: registrableDomain(host),
    wwwHost: `www.${host}`,
    url,
    path,
  };
}

/** Whether `host` belongs to the target (same registrable domain or a subdomain). */
export function isTargetHost(host: string, targetHost: string): boolean {
  const h = stripWww(host);
  const t = stripWww(targetHost);
  if (!h || !t) return false;
  if (h === t || h.endsWith(`.${t}`)) return true;
  const hd = registrableDomain(h);
  const td = registrableDomain(t);
  return Boolean(hd) && hd === td;
}

export function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function domainFromUrl(url: string): string {
  return registrableDomain(hostFromUrl(url));
}

/**
 * The canonical form of a URL: no fragment, no tracking parameters, no
 * `index.html`, no trailing slash, host lowercased.
 */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    if (
      (u.protocol === "https:" && u.port === "443") ||
      (u.protocol === "http:" && u.port === "80")
    ) {
      u.port = "";
    }
    const keep: [string, string][] = [];
    u.searchParams.forEach((value, key) => {
      if (!TRACKING_PARAM_RE.test(key)) keep.push([key, value]);
    });
    keep.sort((a, b) => a[0].localeCompare(b[0]));
    u.search = "";
    for (const [key, value] of keep) u.searchParams.append(key, value);
    u.pathname = u.pathname.replace(/\/(index|default)\.(html?|php|aspx)$/i, "/");
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
    if (!u.pathname) u.pathname = "/";
    return u.toString();
  } catch {
    return raw.split("#")[0] ?? raw;
  }
}

/** A comparison key for a page — ignores protocol and `www`. */
export function pageKey(raw: string): string {
  const normalized = normalizeUrl(raw);
  try {
    const u = new URL(normalized);
    return `${stripWww(u.hostname)}${u.pathname}${u.search}`.toLowerCase();
  } catch {
    return normalized.toLowerCase();
  }
}

export function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}` || "/";
  } catch {
    return "/";
  }
}
