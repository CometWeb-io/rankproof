import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runPlatformQualification } from "./platform-qualify.mjs";

test(
  "small actual worker/HTTP path recovers SIGKILL and measures shared budgets without a priced quality claim",
  { timeout: 15000 },
  async () => {
    const outDir = mkdtempSync(join(tmpdir(), "rankproof-platform-qualify-test-"));
    try {
      const { report } = await runPlatformQualification({ jobs: 24, outDir });
      assert.equal(report.workload.totalJobs, 24);
      assert.equal(report.workload.qualificationSized, false);
      assert.equal(report.operationalAssertionsPassed, true);
      assert.equal(report.pricedQualityQualified, false);
      assert.equal(report.workload.killedProcesses, 1);
      assert.equal(report.workload.recoveredLeaseAttempts, 2);
      assert.equal(report.environment.externalRequests, 0);
      assert.ok(report.storage.peakObservedBytes < 20 * 1024 * 1024);
      assert.equal(report.runs.length, 3);
      assert.equal(report.runs[0].workerProcesses.length, 4);
      assert.ok(report.runs.every((run) => run.workerProcesses.every((worker) => worker.ready)));
      assert.equal(report.runs[0].actualHttp.concurrencyBarrierReleased, true);
      assert.equal(report.runs[0].actualHttp.maxConcurrent, 2);
      assert.ok(
        report.runs[0].workerProcesses.some((worker) => worker.terminal.signal === "SIGKILL"),
      );
      assert.ok(report.runs.every((run) => run.telemetry.qualityGate.pass === false));
      assert.ok(report.runs.every((run) => run.telemetry.costUsd.unknownSamples === run.jobs));
      assert.ok(report.runs[0].telemetry.cpuUserMs.knownTotal > 0);
      assert.ok(report.runs[0].telemetry.maxObservedRssBytes > 0);
      assert.equal(report.unit.monetaryCostUsdPerJob, null);
      assert.equal(report.crashAccounting.cpuUsageOfKilledProcess, null);
      assert.equal(
        JSON.parse(readFileSync(join(outDir, "platform-qualification.json"), "utf8")).schema,
        "platform-qualification.v1",
      );
      await assert.rejects(runPlatformQualification({ jobs: 24, outDir }), /must be empty/);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  },
);
