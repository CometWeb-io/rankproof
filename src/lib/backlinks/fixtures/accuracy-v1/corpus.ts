/** Authored HTML/transport scenarios crossed with generated URL/language identities. */
import type { AccuracyLabel } from "../../measurement-quality.ts";
export type AccuracyCase = {
  id: string; language: string; scenario: string; source: string; target: string;
  expected: AccuracyLabel; html: string; status: number; contentType: string;
};
const languages = [
  ["pl", "żółta łódź"], ["de", "Straße München"], ["fr", "développement durable"],
  ["es", "diseño técnico"], ["ja", "東京 観光"], ["ar", "القاهرة سياحة"],
] as const;
export function accuracyCorpus(): AccuracyCase[] {
  const out: AccuracyCase[] = [];
  for (const [language, anchor] of languages) for (let variant = 0; variant < 8; variant++) {
    const target = `https://target-${language}.example/${encodeURIComponent(anchor)}/${variant}?a=1&b=${variant}`;
    const href = target.replaceAll("&", "&amp;");
    const scenarios: [string, AccuracyLabel, string, number?, string?][] = [
      ["double-quoted", "present", `<a href="${href}">${anchor}</a>`],
      ["single-quoted", "present", `<a href='${href}'>${anchor}</a>`],
      ["unquoted", "present", `<a href=${href}>${anchor}</a>`],
      ["fragment", "present", `<a href="${href}#details">${anchor}</a>`],
      ["relative-base", "present", `<base href="${href}"><a href="">${anchor}</a>`],
      ["nofollow", "present", `<a rel="nofollow ugc sponsored" href="${href}">${anchor}</a>`],
      ["image", "present", `<a href="${href}"><img alt="${anchor}" src="/icon.png"></a>`],
      ["hidden-anchor", "present", `<a hidden href="${href}">${anchor}</a>`],
      ["comment", "absent", `<!-- <a href="${href}">${anchor}</a> -->`],
      ["template", "absent", `<template><a href="${href}">${anchor}</a></template>`],
      ["script-string", "absent", `<script>const link = '<a href="${href}">${anchor}</a>';</script>`],
      ["data-href", "absent", `<a data-href="${href}">${anchor}</a>`],
      ["wrong-path", "absent", `<a href="https://target-${language}.example/other">${anchor}</a>`],
      ["wrong-query", "absent", `<a href="${href}&extra=1">${anchor}</a>`],
      ["wrong-protocol", "absent", `<a href="${href.replace("https:", "http:")}">${anchor}</a>`],
      ["missing-link", "absent", `<p>${anchor}</p>`],
      ["http-block", "unavailable", "Access denied", 403],
      ["browser-challenge", "unavailable", "<title>Just a moment</title><p>Verify you are human</p>"],
      ["non-html", "unavailable", `{"link":"${target}"}`, 200, "application/json"],
      ["javascript-shell", "unavailable", "<script src='/app.js'></script>"],
      ["rate-limit", "unavailable", "Slow down", 429],
      ["http-failure", "unavailable", "Unavailable", 503],
      ["http-404", "absent", "Missing", 404],
      ["http-410", "absent", "Gone", 410],
    ];
    for (const [scenario, expected, fragment, status = 200, contentType = "text/html"] of scenarios) {
      const id = `${language}-${variant}-${scenario}`;
      const html = scenario === "javascript-shell" ? `<html lang="${language}"><body>${fragment}</body></html>` : `<html lang="${language}"><body><p>${anchor} — article content.</p>${fragment}</body></html>`;
      out.push({ id, language, scenario, source: `https://${id}.source.example/post`, target, expected, html, status, contentType });
    }
  }
  return out;
}
