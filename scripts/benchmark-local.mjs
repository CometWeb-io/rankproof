#!/usr/bin/env node
/**
 * Synthetic CPU benchmarks. Run in a source checkout.
 * No network access, hosted services or production fixtures.
 */
import { performance } from "node:perf_hooks";
import { parseTarget, pageKey, registrableDomain } from "../src/lib/backlinks/parse.ts";
import { parseAnchors } from "../src/lib/backlinks/html.ts";

const hosts = [
  "blog.sklep.com.pl",
  "news.bbc.co.uk",
  "tenant.github.io",
  "www.пример.рф",
  "foo.city.kawasaki.jp",
  "other.blogspot.com",
];

const anchors = [];
for (let i = 0; i < 80; i++) {
  const href = `https://partner${i}.example/path?sku=A`;
  anchors.push(`<a data-href="/shadow" href="${href}">${i}</a>`);
}
const html = `<html><body><main>${anchors.join("")}</main></body></html>`;

function measure(name, count, work) {
  for (let i = 0; i < 200; i++) work(i);
  const batches = 12;
  const perBatch = Math.ceil(count / batches);
  const durations = [];
  let checksum = 0;
  for (let batch = 0; batch < batches; batch++) {
    const start = performance.now();
    for (let i = 0; i < perBatch; i++) {
      checksum += work(batch * perBatch + i);
    }
    durations.push((performance.now() - start) / perBatch);
  }
  durations.sort((a, b) => a - b);
  return {
    name,
    operations: batches * perBatch,
    p50Ms: Number(durations[6].toFixed(4)),
    p95Ms: Number(durations[11].toFixed(4)),
    checksum,
  };
}

function hostAt(index) {
  return hosts[index % hosts.length];
}

function suffixWork(index) {
  return registrableDomain(hostAt(index)).length;
}

function targetWork(index) {
  return parseTarget(hostAt(index)).host.length;
}

function pageWork(index) {
  return pageKey(`https://EXAMPLE.com/Products?sku=A&utm_source=${index}`).length;
}

function anchorWork() {
  return parseAnchors(html, "https://source.example/news").length;
}

const results = [
  measure("PSL/eTLD+1", 12_000, suffixWork),
  measure("Target validation", 12_000, targetWork),
  measure("Page normalization", 10_000, pageWork),
  measure("HTML link extraction (80 anchors)", 480, anchorWork),
];

const report = {
  benchmark: "rankproof-local-v1",
  runtime: process.version,
  platform: process.platform,
  architecture: process.arch,
  disclaimer: "Synthetic microbenchmarks; not live crawl latency or SEO accuracy.",
  results,
};
console.log(JSON.stringify(report, null, 2));
