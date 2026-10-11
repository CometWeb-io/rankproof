#!/usr/bin/env node
/**
 * Hermetic, low-cost microbenchmarks. No network, database, or external API.
 * Run: npm run bench:local
 */
import { performance } from "node:perf_hooks";
import { parseTarget, pageKey, registrableDomain } from "../src/lib/backlinks/parse.ts";
import { parseAnchors } from "../src/lib/backlinks/html.ts";

function benchmark(name, samples, work) {
  for (let i = 0; i < 200; i++) work(i);
  const batches = 12;
  const perBatch = Math.ceil(samples / batches);
  const durations = [];
  let checksum = 0;
  for (let batch = 0; batch < batches; batch++) {
    const start = performance.now();
    for (let i = 0; i < perBatch; i++) checksum += work(batch * perBatch + i);
    durations.push((performance.now() - start) / perBatch);
  }
  durations.sort((a, b) => a - b);
  return {
    name,
    operations: batches * perBatch,
    p50Ms: Number(durations[Math.floor(durations.length * 0.5)].toFixed(4)),
    p95Ms: Number(durations[Math.ceil(durations.length * 0.95) - 1].toFixed(4)),
    checksum,
  };
}

const hosts = [
  "blog.sklep.com.pl",
  "news.bbc.co.uk",
  "tenant.github.io",
  "www.пример.рф",
  "foo.city.kawasaki.jp",
  "other.blogspot.com",
];
const html = `<html><body><main>${Array.from(
  { length: 80 },
  (_, i) =>
    `<p><a data-href="https://fake.example/${i}" href="https://partner${i}.example/path?sku=A">${i}</a></p>`,
).join("")}</main></body></html>`;

const results = [
  benchmark("PSL/eTLD+1", 12_000, (i) => registrableDomain(hosts[i % hosts.length]).length),
  benchmark("Target validation", 12_000, (i) => parseTarget(hosts[i % hosts.length]).host.length),
  benchmark("Page normalization", 10_000, (i) =>
    pageKey(`https://EXAMPLE.com/Products?sku=A&utm_source=${i}`).length,
  ),
  benchmark("HTML link extraction (80 anchors)", 480, () =>
    parseAnchors(html, "https://source.example/news").length,
  ),
];

console.log(
  JSON.stringify(
    {
      benchmark: "rankproof-local-v1",
      runtime: process.version,
      platform: process.platform,
      architecture: process.arch,
      disclaimer: "Synthetic, single-process microbenchmarks; not live crawl latency or SEO accuracy.",
      results,
    },
    null,
    2,
  ),
);
