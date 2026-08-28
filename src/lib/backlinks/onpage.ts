import {
  countLinks,
  countWords,
  extractCanonical,
  extractDescription,
  extractHeadings,
  extractLang,
  extractOg,
  extractRobotsMeta,
  extractSchemaTypes,
  extractTitle,
} from "./html.ts";
import { hostFromUrl, isTargetHost } from "./parse.ts";
import type { Issue, OnPageAudit } from "./types.ts";

export type OnPageInput = {
  html: string;
  url: string;
  host: string;
  https: boolean;
  title?: string | null;
  description?: string | null;
  canonical?: string | null;
  robotsNoindex?: boolean;
  lang?: string | null;
  primaryKeyword?: string | null;
};

/**
 * An on-page audit aimed at the SERP: title, meta, H1, schema, canonical, content.
 * Czysta funkcja — testowalna bez sieci.
 */
export function auditOnPage(input: OnPageInput): OnPageAudit {
  const html = input.html ?? "";
  const title = (input.title ?? extractTitle(html) ?? "").trim() || null;
  const description = (input.description ?? extractDescription(html) ?? "").trim() || null;
  const h1 = extractHeadings(html, "h1", 6);
  const h2 = extractHeadings(html, "h2", 10);
  const canonical = input.canonical ?? extractCanonical(html);
  const robots = extractRobotsMeta(html);
  const noindex = input.robotsNoindex ?? robots.noindex;
  const og = extractOg(html);
  const schemaTypes = extractSchemaTypes(html);
  const wordCount = countWords(html);
  const links = html ? countLinks(html, input.url, input.host) : { internal: 0, external: 0 };
  const lang = input.lang ?? extractLang(html);
  const keyword = (input.primaryKeyword ?? "").trim().toLowerCase();

  const titleLength = title?.length ?? 0;
  const descriptionLength = description?.length ?? 0;
  const canonicalOk = canonicalIsOk(canonical, input.host);
  const titleHasKw = keyword.length >= 4 && (title ?? "").toLowerCase().includes(keyword);
  const h1HasKw = keyword.length >= 4 && h1.some((h) => h.toLowerCase().includes(keyword));

  const issues: Issue[] = [];
  if (!title) {
    issues.push({
      id: "seo-title",
      severity: "high",
      title: "Missing page title",
      detail:
        "Without a <title> the search engine guesses a heading from the URL. This is the cheapest SERP fix there is.",
      count: 1,
      samples: [input.url],
    });
  } else if (titleLength < 12) {
    issues.push({
      id: "seo-title-short",
      severity: "medium",
      title: "The title is too short",
      detail: "A healthy title runs 30–60 characters and contains the main keyword. A short one loses clicks.",
      count: titleLength,
      samples: [title],
    });
  } else if (titleLength > 70) {
    issues.push({
      id: "seo-title-long",
      severity: "low",
      title: "The title is too long",
      detail: "Google truncates titles beyond about 60 characters. The most important keyword belongs at the start.",
      count: titleLength,
      samples: [title],
    });
  }

  if (!description) {
    issues.push({
      id: "seo-description",
      severity: "medium",
      title: "Missing meta description",
      detail:
        "The description is not a ranking factor, but it drives CTR in the SERP. Aim for 120–160 characters with a call to action.",
      count: 1,
      samples: [],
    });
  } else if (descriptionLength < 50 || descriptionLength > 180) {
    issues.push({
      id: "seo-description-len",
      severity: "low",
      title: "Meta description out of range",
      detail: "The optimal length is 70–160 characters. Too short does not sell; too long gets truncated.",
      count: descriptionLength,
      samples: [description.slice(0, 80)],
    });
  }

  if (h1.length === 0) {
    issues.push({
      id: "seo-h1",
      severity: "medium",
      title: "Missing H1 heading",
      detail: "The H1 is the main topical signal for a page. There should be exactly one, and it should contain the target keyword.",
      count: 0,
      samples: [],
    });
  } else if (h1.length > 1) {
    issues.push({
      id: "seo-h1-many",
      severity: "low",
      title: "More than one H1",
      detail: "Multiple H1s dilute the topic. Keep one main heading and demote the rest to H2.",
      count: h1.length,
      samples: h1.slice(0, 3),
    });
  }

  if (noindex) {
    issues.push({
      id: "seo-noindex",
      severity: "high",
      title: "The page is set to noindex",
      detail: "No backlink will improve rankings while meta robots or X-Robots-Tag blocks indexing.",
      count: 1,
      samples: [input.url],
    });
  }

  if (canonical && !canonicalOk) {
    issues.push({
      id: "seo-canonical",
      severity: "medium",
      title: "Canonical points to another domain",
      detail:
        "A canonical link pointing off-site hands the entire SERP value to someone else. Check whether that is intended.",
      count: 1,
      samples: [canonical],
    });
  }

  if (schemaTypes.length === 0) {
    issues.push({
      id: "seo-schema",
      severity: "low",
      title: "No structured data",
      detail:
        "JSON-LD (Organization, Article, FAQ, Product) helps with rich results and sets the page apart from competitors in the SERP.",
      count: 0,
      samples: [],
    });
  }

  if (wordCount > 0 && wordCount < 250) {
    issues.push({
      id: "seo-thin",
      severity: "medium",
      title: "Thin content",
      detail:
        "Pages under about 300 words rarely win competitive keywords. Expand the topic or consolidate pages.",
      count: wordCount,
      samples: [],
    });
  }

  if (!input.https) {
    issues.push({
      id: "seo-https",
      severity: "high",
      title: "No HTTPS",
      detail: "Browsers mark HTTP as insecure, and HTTPS is a ranking signal.",
      count: 1,
      samples: [input.url],
    });
  }

  if (keyword && !titleHasKw && title) {
    issues.push({
      id: "seo-kw-title",
      severity: "info",
      title: "The main keyword is missing from the title",
      detail: `The keyword "${keyword}" does not appear in the <title>. It is the simplest on-page signal available.`,
      count: 1,
      samples: [title],
    });
  }

  let score = 8;
  if (title && titleLength >= 12 && titleLength <= 70) score += 14;
  else if (title) score += 6;
  if (description && descriptionLength >= 70 && descriptionLength <= 160) score += 10;
  else if (description) score += 4;
  if (h1.length === 1) score += 12;
  else if (h1.length > 1) score += 5;
  if (titleHasKw) score += 8;
  if (h1HasKw) score += 6;
  if (canonicalOk) score += 6;
  if (input.https) score += 6;
  if (schemaTypes.length > 0) score += 8;
  if (og.image) score += 4;
  if (wordCount >= 300) score += 8;
  else if (wordCount >= 120) score += 3;
  if (links.internal >= 5) score += 5;
  if (!noindex) score += 8;
  if (lang) score += 2;
  score = Math.max(0, Math.min(100, score));
  if (noindex) score = Math.min(score, 28);

  return {
    title,
    titleLength,
    description,
    descriptionLength,
    h1,
    h2,
    canonical,
    canonicalOk,
    robotsNoindex: noindex,
    ogTitle: og.title,
    ogImage: og.image,
    schemaTypes,
    wordCount,
    internalLinks: links.internal,
    externalLinks: links.external,
    https: input.https,
    lang,
    issues,
    score,
  };
}

function canonicalIsOk(canonical: string | null, host: string): boolean {
  if (!canonical) return true;
  const h = hostFromUrl(canonical);
  if (!h) return true;
  return isTargetHost(h, host);
}
