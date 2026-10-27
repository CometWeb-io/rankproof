import { publicSuffix, registeredDomain } from "./public-suffix.ts";

const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/i;

/** Exact relation identity: only URL-standard normalization and fragment removal. */
export const URL_IDENTITY_POLICY = "exact-http-url-v2";
/** Complete ICANN and private suffix rules; URL relations retain exact identities. */
export const DOMAIN_POLICY = "psl-3929462-private-v1";

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

/** eTLD+1 with ICANN and private suffix isolation. */
export function registrableDomain(host: string): string {
  return registeredDomain(stripWww(host));
}

export function tldOf(host: string): string {
  return publicSuffix(stripWww(host));
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
    if (parsed.username || parsed.password) throw new Error("Embedded credentials are forbidden.");
    host = stripWww(parsed.hostname).replace(/\.$/, "");
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

/** Preserve path/query case, order, business/tracking parameters and trailing slash. */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    return u.href;
  } catch {
    return raw.split("#")[0] ?? raw;
  }
}

/** Exact page key; protocol/www variants require observed redirects to relate them. */
export function pageKey(raw: string): string {
  return normalizeUrl(raw);
}

export function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}` || "/";
  } catch {
    return "/";
  }
}
