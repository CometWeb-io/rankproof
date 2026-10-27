import assert from "node:assert/strict";
import { test } from "node:test";
import {
  calibrationDataset,
  freezeCalibrationHoldout,
  evaluateCalibrationStudy,
  type CalibrationDataset,
  type CalibrationStudy,
} from "./calibration.ts";

/** Generated labels only exercise the deterministic gate; they are not real annotations. */
function dataset(prefix: string, count: number): CalibrationDataset {
  return {
    schemaVersion: 1,
    datasetId: prefix,
    kind: "synthetic",
    cases: Array.from({ length: count }, (_, index) => ({
      id: `${prefix}-${index}`,
      sourceUrl: `https://${prefix}-${index}.example/page`,
      targetUrl: "https://target.example/",
      sourceContent: `${prefix} synthetic source ${index}`,
      groundTruth: {
        label: (index % 2) as 0 | 1,
        kind: "synthetic",
        annotatedBy: "synthetic-fixture",
        annotatedAt: "2026-10-20T00:00:00Z",
        evidenceRef: `synthetic:${prefix}:${index}`,
      },
    })),
  };
}
function study(): CalibrationStudy {
  const tuning = dataset("tuning", 100),
    holdout = dataset("holdout", 200);
  return {
    schemaVersion: 1,
    candidateId: "synthetic-candidate-v1",
    event: "exact_html_anchor_present",
    predictionKind: "probability",
    predictionEvidenceRef: "synthetic:declared-test-predictions",
    predictedAt: "2026-10-22T00:00:00Z",
    tuning,
    holdout,
    predictions: holdout.cases.map((row) => ({
      caseId: row.id,
      value: row.groundTruth.label ? 0.8 : 0.2,
    })),
  };
}
const freeze = (input: CalibrationStudy) =>
  freezeCalibrationHoldout(input, "fixture", "2026-10-21T00:00:00Z");

test("frozen synthetic holdout yields checkable Brier/ECE without qualification", () => {
  const input = study(),
    lock = freeze(input);
  const report = evaluateCalibrationStudy(input, lock);
  assert.equal(report.status, "synthetic_evaluation");
  assert.ok(Math.abs(report.brier! - 0.04) < 1e-12);
  assert.ok(Math.abs(report.ece! - 0.2) < 1e-12);
  assert.equal(
    report.reliability!.reduce((sum, b) => sum + b.count, 0),
    200,
  );
  assert.equal(report.calibrationQualified, false);
  assert.throws(
    () => evaluateCalibrationStudy(input, lock, [lock.datasetHash]),
    /already been evaluated/,
  );
  const reordered = {
    ...input,
    holdout: { ...input.holdout, cases: [...input.holdout.cases].reverse() },
  };
  assert.equal(evaluateCalibrationStudy(reordered, lock).holdout.datasetHash, lock.datasetHash);
});

test("freeze rejects case, source and content leakage, small sets and missing ground truth", () => {
  for (const mutate of [
    (s: CalibrationStudy) => {
      s.holdout.cases[0]!.id = s.tuning.cases[0]!.id;
    },
    (s: CalibrationStudy) => {
      s.holdout.cases[0]!.sourceUrl = s.tuning.cases[0]!.sourceUrl.replace("/page", "/another");
    },
    (s: CalibrationStudy) => {
      s.holdout.cases[0]!.sourceContent = s.tuning.cases[0]!.sourceContent;
    },
    (s: CalibrationStudy) => {
      s.holdout.cases = s.holdout.cases.slice(0, 30);
    },
    (s: CalibrationStudy) => {
      delete (s.holdout.cases[0]!.groundTruth as { label?: number }).label;
    },
  ]) {
    const input = study();
    mutate(input);
    assert.throws(() => freeze(input));
  }
  const duplicated = dataset("duplicate", 200);
  duplicated.cases[1]!.sourceContent = duplicated.cases[0]!.sourceContent;
  assert.throws(() => calibrationDataset(duplicated), /Duplicate source content/);
});

test("frozen contents and tuning are immutable, prediction sets must be explicit event probabilities", () => {
  const input = study(),
    lock = freeze(input);
  for (const partition of ["tuning", "holdout"] as const) {
    const altered = structuredClone(input);
    altered[partition].cases[0]!.groundTruth.label = 1;
    assert.throws(() => evaluateCalibrationStudy(altered, lock), /does not match/);
  }
  const heuristic = {
    ...input,
    predictionKind: "heuristic_score",
    predictions: input.predictions.map((p) => ({ ...p, value: 80 })),
  };
  const result = evaluateCalibrationStudy(heuristic, lock);
  assert.equal(result.status, "not_calibrated");
  assert.equal(result.brier, null);
  assert.equal(result.ece, null);
  assert.equal(result.reliability, null);
  assert.throws(
    () =>
      evaluateCalibrationStudy(
        { ...input, predictions: [{ caseId: "holdout-0", value: 80 }] },
        lock,
      ),
    /\[0,1\]/,
  );
  assert.throws(
    () =>
      evaluateCalibrationStudy(
        { ...input, predictions: [input.predictions[0], input.predictions[0]] },
        lock,
      ),
    /duplicate/,
  );
  assert.equal(
    evaluateCalibrationStudy({ ...input, predictions: input.predictions.slice(1) }, lock).brier,
    null,
  );
  assert.throws(
    () => evaluateCalibrationStudy({ ...input, predictedAt: "2026-10-20T00:00:00Z" }, lock),
    /after its freeze/,
  );
});

test("CLI freezes immutably and consumes each local holdout lock only once", async () => {
  const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { spawnSync } = await import("node:child_process");
  const directory = await mkdtemp(join(tmpdir(), "rankproof-calibration-"));
  const runner = fileURLToPath(new URL("../../../scripts/calibration.mjs", import.meta.url));
  const command = (...args: string[]) =>
    spawnSync(process.execPath, ["--experimental-strip-types", runner, ...args], {
      encoding: "utf8",
      timeout: 30000,
    });
  try {
    const input = study();
    input.predictedAt = new Date(Date.now() + 10000).toISOString();
    const inputFile = join(directory, "study.json"),
      lockFile = join(directory, "holdout.lock.json");
    await writeFile(inputFile, JSON.stringify(input));
    const frozen = command("freeze", inputFile, lockFile, "synthetic-reviewer");
    assert.equal(frozen.status, 0, frozen.stderr);
    assert.notEqual(command("freeze", inputFile, lockFile, "another").status, 0);
    const evaluated = command("evaluate", inputFile, lockFile);
    assert.equal(evaluated.status, 0, evaluated.stderr);
    assert.equal(JSON.parse(evaluated.stdout).calibrationQualified, false);
    const receiptFile = JSON.parse(evaluated.stdout).receiptFile;
    const receipt = await readFile(receiptFile, "utf8");
    const reused = command("evaluate", inputFile, lockFile);
    assert.notEqual(reused.status, 0);
    assert.match(reused.stderr, /single-use/);
    assert.equal(await readFile(receiptFile, "utf8"), receipt);
    const renamedLock = join(directory, "renamed.lock.json");
    await writeFile(renamedLock, await readFile(lockFile, "utf8"));
    assert.notEqual(command("evaluate", inputFile, renamedLock).status, 0);
    const schema = command("schema");
    assert.equal(schema.status, 0);
    assert.equal(JSON.parse(schema.stdout).$id, "urn:rankproof:calibration-study:v1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
