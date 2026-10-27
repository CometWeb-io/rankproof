/** Offline fixture benchmark: this never queries the public network. */
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { accuracyCorpus } from "../src/lib/backlinks/fixtures/accuracy-v1/corpus.ts";
import { accuracyMetrics } from "../src/lib/backlinks/measurement-quality.ts";
import { verifyBacklinks } from "../src/lib/backlinks/verify-api.server.ts";
import { clearNetCache, setHostResolverForTests } from "../src/lib/backlinks/net.server.ts";
import { clearRobotsCache } from "../src/lib/backlinks/robots.server.ts";

export async function benchmarkAccuracy() {
  const corpus = accuracyCorpus();
  const bySource = new Map(corpus.map((item) => [item.source, item]));
  const originalFetch = globalThis.fetch;
  const rows = [];
  setHostResolverForTests(async () => ["93.184.216.34"]);
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
    const item = bySource.get(url);
    if (!item) throw new Error(`Unexpected benchmark request: ${url}`);
    return new Response(item.html, {
      status: item.status,
      headers: { "content-type": item.contentType },
    });
  };
  try {
    for (let start = 0; start < corpus.length; start += 50) {
      const batch = corpus.slice(start, start + 50);
      const response = await verifyBacklinks({
        items: batch.map((item) => ({ source_url: item.source, target_url: item.target })),
      });
      for (const [index, observation] of response.results.entries())
        rows.push({
          id: batch[index].id,
          expected: batch[index].expected,
          observed: observation.status,
          reason: observation.reason,
        });
    }
  } finally {
    globalThis.fetch = originalFetch;
    setHostResolverForTests(null);
    clearNetCache();
    clearRobotsCache();
  }
  const expectedStatus = { present: "confirmed", absent: "not_found", unavailable: "error" };
  return {
    schema_version: "accuracy-benchmark-v1",
    corpus: {
      id: "synthetic-html-transport-v1",
      sha256: createHash("sha256").update(JSON.stringify(corpus)).digest("hex"),
      kind: "synthetic_generated",
      scenarios: 24,
      languages: 6,
      identitiesPerLanguage: 8,
      cases: corpus.length,
      independentRealWorldAnnotations: 0,
    },
    metrics: accuracyMetrics(rows),
    failures: rows.filter((row) => row.observed !== expectedStatus[row.expected]),
    realWorldAccuracyQualified: false,
    limitation:
      "1152 generated cases are 24 authored scenarios crossed with six languages and eight URL identities, not 1152 independently annotated websites. HTTP is mocked. This tests regressions, not internet recall, live hosting, DNS rebinding, rendered DOM, real-world precision or ranking effectiveness.",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await benchmarkAccuracy();
  console.log(JSON.stringify(report, null, 2));
  if (report.failures.length) process.exitCode = 1;
}
