import assert from "node:assert/strict";
import { test } from "node:test";
import {
  importCitationDataset,
  replayCitationDataset,
  type CitationDataset,
  type CitationSample,
} from "./citation-lab.ts";

const sample = (id: string, overrides: Partial<CitationSample> = {}): CitationSample => ({
  id,
  runId: id,
  promptId: "p1",
  provider: "test",
  model: "model",
  modelVersion: "2026-10",
  language: "en",
  region: "US",
  generation: { temperature: 0, seed: null },
  kind: "synthetic",
  capturedAt: "2026-10-27T10:00:00Z",
  evidenceRef: "synthetic:test",
  status: "ok",
  responseText: "Example https://one.example/path",
  citations: [{ url: "https://one.example/path", evidenceText: "https://one.example/path" }],
  mentions: ["Example"],
  ...overrides,
});
const dataset = (samples: CitationSample[]): CitationDataset => ({
  schemaVersion: 1,
  prompts: [{ id: "p1", version: "1", text: "Show sources", systemPrompt: "" }],
  samples,
});

test("citation replay separates synthetic, observed, model versions and markets", () => {
  const input = dataset([
    sample("a"),
    sample("b", { kind: "observed", evidenceRef: "capture:1" }),
    sample("c", { region: "DE" }),
    sample("d", { modelVersion: "other" }),
  ]);
  const result = replayCitationDataset(input);
  assert.equal(result.summaries.length, 4);
  assert.ok(result.summaries.every((g) => g.attempts === 1));
  assert.equal(
    replayCitationDataset({ ...input, samples: [...input.samples].reverse() }).datasetHash,
    result.datasetHash,
  );
});

test("variability and denominators exclude failed attempts and duplicate citations in a response", () => {
  const a = sample("a");
  a.citations.push(a.citations[0]!);
  const input = dataset([
    a,
    sample("b", { citations: [], mentions: [] }),
    sample("c", { status: "error", responseText: "timeout", citations: [], mentions: [] }),
  ]);
  const report = replayCitationDataset(input).summaries[0]!;
  assert.equal(report.attempts, 3);
  assert.equal(report.successful, 2);
  assert.equal(report.failed, 1);
  assert.deepEqual(report.citationHosts, [{ host: "one.example", responses: 1, denominator: 2 }]);
  assert.equal(report.variability.comparablePairs, 1);
  assert.equal(report.variability.differingPairs, 1);
  assert.equal(report.variability.distinctSets, 2);
});

test("imports reject duplicate attempts, missing model version and fabricated response annotations", () => {
  assert.throws(
    () => importCitationDataset(dataset([sample("a"), sample("b", { runId: "a" })])),
    /Duplicate prompt/,
  );
  assert.throws(
    () => importCitationDataset(dataset([sample("a", { modelVersion: "" })])),
    /metadata/,
  );
  assert.throws(
    () => importCitationDataset(dataset([sample("a", { mentions: ["Not in response"] })])),
    /Mention absent/,
  );
  assert.throws(
    () => importCitationDataset(dataset([sample("a", { responseText: "Nothing" })])),
    /evidence text absent/,
  );
  assert.throws(
    () => importCitationDataset(dataset([sample("a", { status: "error" })])),
    /Failed attempts/,
  );
  const input = dataset([sample("a")]);
  const imported = importCitationDataset(input);
  input.samples[0]!.citations[0]!.url = "https://mutated.example/";
  assert.equal(imported.samples[0]!.citations[0]!.url, "https://one.example/path");
});

test("generic response substrings cannot authenticate an invented citation URL", () => {
  const forged = sample("forged", {
    kind: "observed",
    evidenceRef: "capture:forged",
    responseText: "No sources were cited in this response.",
    citations: [{ url: "https://invented.example/", evidenceText: "sources" }],
    mentions: [],
  });
  assert.throws(() => replayCitationDataset(dataset([forged])), /citation|evidence/i);
});
