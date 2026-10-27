import { createHash } from "node:crypto";

export type CitationPrompt = { id: string; version: string; text: string; systemPrompt: string };
export type CitationSample = {
  id: string;
  runId: string;
  promptId: string;
  provider: string;
  model: string;
  modelVersion: string;
  language: string;
  region: string;
  generation: { temperature: number | null; seed: number | null };
  kind: "observed" | "synthetic";
  capturedAt: string;
  evidenceRef: string;
  status: "ok" | "error";
  responseText: string;
  citations: { url: string; evidenceText: string }[];
  mentions: string[];
};
export type CitationDataset = {
  schemaVersion: 1;
  prompts: CitationPrompt[];
  samples: CitationSample[];
};

const requiredText = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Validates and copies the import; caller mutation cannot change an accepted dataset. */
export function importCitationDataset(input: unknown): CitationDataset {
  if (
    !record(input) ||
    input.schemaVersion !== 1 ||
    !Array.isArray(input.prompts) ||
    !Array.isArray(input.samples) ||
    input.prompts.length === 0 ||
    input.prompts.length > 1000 ||
    input.samples.length > 10_000
  )
    throw new Error("Invalid citation dataset envelope.");
  const promptIds = new Set<string>();
  const prompts = input.prompts.map((p): CitationPrompt => {
    if (
      !record(p) ||
      !requiredText(p.id) ||
      !requiredText(p.version) ||
      !requiredText(p.text) ||
      typeof p.systemPrompt !== "string" ||
      p.text.length + p.systemPrompt.length > 100_000 ||
      promptIds.has(p.id)
    )
      throw new Error("Invalid or duplicate citation prompt.");
    promptIds.add(p.id);
    return { id: p.id, version: p.version, text: p.text, systemPrompt: p.systemPrompt };
  });
  const sampleIds = new Set<string>();
  const attempts = new Set<string>();
  let importedBytes = 0;
  const samples = input.samples.map((s): CitationSample => {
    if (
      !record(s) ||
      !requiredText(s.id) ||
      !requiredText(s.runId) ||
      !requiredText(s.promptId) ||
      !promptIds.has(s.promptId) ||
      !requiredText(s.provider) ||
      !requiredText(s.model) ||
      !requiredText(s.modelVersion) ||
      !requiredText(s.language) ||
      !requiredText(s.region) ||
      !requiredText(s.capturedAt) ||
      !Number.isFinite(Date.parse(s.capturedAt)) ||
      !requiredText(s.evidenceRef) ||
      !["observed", "synthetic"].includes(String(s.kind)) ||
      !["ok", "error"].includes(String(s.status)) ||
      typeof s.responseText !== "string" ||
      !Array.isArray(s.citations) ||
      !Array.isArray(s.mentions) ||
      s.citations.length > 1000 ||
      s.mentions.length > 1000 ||
      !record(s.generation) ||
      !(
        s.generation.temperature === null ||
        (typeof s.generation.temperature === "number" &&
          Number.isFinite(s.generation.temperature) &&
          s.generation.temperature >= 0 &&
          s.generation.temperature <= 2)
      ) ||
      !(
        s.generation.seed === null ||
        (typeof s.generation.seed === "number" && Number.isSafeInteger(s.generation.seed))
      )
    )
      throw new Error("Invalid citation sample or missing reproducibility metadata.");
    importedBytes += Buffer.byteLength(s.responseText);
    if (Buffer.byteLength(s.responseText) > 2_000_000 || importedBytes > 20_000_000)
      throw new Error("Citation response size limit exceeded.");
    if (sampleIds.has(s.id)) throw new Error("Duplicate citation sample id.");
    sampleIds.add(s.id);
    const attempt = JSON.stringify([
      s.runId,
      s.promptId,
      s.provider,
      s.model,
      s.modelVersion,
      s.language,
      s.region,
      s.generation.temperature,
      s.generation.seed,
      s.kind,
    ]);
    if (attempts.has(attempt))
      throw new Error("Duplicate prompt/configuration attempt within a run.");
    attempts.add(attempt);
    const responseText = s.responseText;
    const citations = s.citations.map((c) => {
      if (!record(c) || !requiredText(c.url) || !requiredText(c.evidenceText))
        throw new Error("Citation needs a URL and response evidence text.");
      const url = new URL(c.url);
      if (
        !/^https?:$/.test(url.protocol) ||
        url.username ||
        url.password ||
        !responseText.includes(c.evidenceText) ||
        (!c.evidenceText.includes(c.url) && !c.evidenceText.includes(url.href))
      )
        throw new Error("Invalid citation URL or evidence text absent from response.");
      return { url: url.href, evidenceText: c.evidenceText };
    });
    const mentions = s.mentions.map((mention) => {
      if (!requiredText(mention) || !responseText.includes(mention))
        throw new Error("Mention absent from response.");
      return mention;
    });
    if (s.status === "error" && (citations.length || mentions.length))
      throw new Error("Failed attempts cannot carry successful citations or mentions.");
    if (s.status === "ok" && !s.responseText.trim())
      throw new Error("Successful samples need response text.");
    return {
      id: s.id,
      runId: s.runId,
      promptId: s.promptId,
      provider: s.provider,
      model: s.model,
      modelVersion: s.modelVersion,
      language: s.language,
      region: s.region,
      generation: { temperature: s.generation.temperature, seed: s.generation.seed },
      kind: s.kind as CitationSample["kind"],
      capturedAt: s.capturedAt,
      evidenceRef: s.evidenceRef,
      status: s.status as CitationSample["status"],
      responseText: s.responseText,
      citations,
      mentions,
    };
  });
  return { schemaVersion: 1, prompts, samples };
}

/** Replay uses only supplied records; it never calls a model or fetches a citation. */
export function replayCitationDataset(input: unknown) {
  const dataset = importCitationDataset(input);
  const prompts = new Map(dataset.prompts.map((p) => [p.id, p]));
  const groups = new Map<string, { cohort: object; samples: CitationSample[] }>();
  for (const sample of dataset.samples) {
    const prompt = prompts.get(sample.promptId)!;
    const cohort = {
      prompt,
      provider: sample.provider,
      model: sample.model,
      modelVersion: sample.modelVersion,
      language: sample.language,
      region: sample.region,
      generation: sample.generation,
      kind: sample.kind,
    };
    const key = hash(cohort);
    const group = groups.get(key) ?? { cohort, samples: [] };
    group.samples.push(sample);
    groups.set(key, group);
  }
  const summaries = [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cohortHash, { cohort, samples }]) => {
      const successful = samples.filter((s) => s.status === "ok");
      const hosts = new Map<string, number>();
      const mentions = new Map<string, number>();
      const citationSets = new Map<string, number>();
      for (const sample of successful) {
        const citedHosts = [
          ...new Set(sample.citations.map((c) => new URL(c.url).hostname)),
        ].sort();
        for (const host of citedHosts) hosts.set(host, (hosts.get(host) ?? 0) + 1);
        for (const mention of new Set(sample.mentions))
          mentions.set(mention, (mentions.get(mention) ?? 0) + 1);
        const key = JSON.stringify(citedHosts);
        citationSets.set(key, (citationSets.get(key) ?? 0) + 1);
      }
      const pairs = (successful.length * (successful.length - 1)) / 2;
      const equalPairs = [...citationSets.values()].reduce((sum, n) => sum + (n * (n - 1)) / 2, 0);
      return {
        cohortHash,
        cohort,
        attempts: samples.length,
        successful: successful.length,
        failed: samples.length - successful.length,
        citationHosts: [...hosts]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([host, responses]) => ({ host, responses, denominator: successful.length })),
        mentions: [...mentions]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([mention, responses]) => ({ mention, responses, denominator: successful.length })),
        variability: {
          unit: "distinct-citation-host-set",
          distinctSets: citationSets.size,
          comparablePairs: pairs,
          differingPairs: pairs - equalPairs,
        },
        sampleIds: samples.map((s) => s.id).sort(),
      };
    });
  const canonical = {
    ...dataset,
    prompts: [...dataset.prompts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    samples: [...dataset.samples].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
  return {
    schemaVersion: 1,
    datasetHash: hash(canonical),
    dataset,
    summaries,
    limitations: [
      "Observed is an importer assertion backed by the supplied evidence reference; authenticity is not independently verified.",
      "Citations and mentions are explicitly annotated from retained response text, not inferred by a URL regex.",
      "Counts describe supplied successful responses within each cohort, never global AI traffic or visibility.",
      "Repeated trials are descriptive samples, not an independent random population or confidence interval.",
    ],
  };
}
