import assert from "node:assert/strict";
import { test } from "node:test";

import { runSustainedRecovery } from "../scripts/sustained-recovery.mjs";

test("72-hour production-function oracle reconciles over 10,000 admissions and 1,000 interruptions", {
  timeout: 900_000,
}, async () => {
  const report = await runSustainedRecovery({ seed: 0x20260928 });
  console.log(`sustained-oracle-report ${JSON.stringify(report)}`);
  assert.equal(report.seed, 0x20260928);
  assert.equal(report.durationMs, 72 * 60 * 60 * 1_000);
  assert.deepEqual(report.cohorts.map((item) => item.panes), [1, 6, 10]);
  assert.ok(report.admitted >= 10_000);
  assert.ok(report.interrupted >= 1_000);
  assert.ok(report.resets >= 70);
  assert.deepEqual(report.peakSampling, { operationStride: 100, includesFinal: true });
  assert.ok(report.maximumSampledLedgerBytes <= 2 * 1024 * 1024);
  assert.ok(report.maximumSampledDetailedReceipts <= 512);
  assert.ok(report.maximumSampledDebtGroups <= 128);
  assert.equal(report.reconciliation.ok, true, JSON.stringify(report.reconciliation));
  assert.ok(report.cohorts.every((item) => item.unterminalizedReceipts > 0 &&
    item.outstandingCharge.core >= item.unterminalizedCharge.core &&
    item.outstandingCharge.graphql >= item.unterminalizedCharge.graphql));
  assert.ok(report.cohorts.every((item) => item.completionFaults.length === 1 &&
    item.completionFaults[0].retainedBeforeRetry &&
    item.completionFaults[0].settledAfterRetry));
  assert.ok(report.cohorts.every((item) => item.firstSuccessDelayMs <= 60_000));
  assert.ok(report.cohorts.every((item) => item.sourceCadenceMet),
    JSON.stringify(report.cohorts.map((item) => [item.id, item.maximumSourceGapMs, item.allowedSourceGapMs])));
  const mixed = report.cohorts.find((item) => item.id === "mixed");
  assert.ok(mixed.sleepSpanningGaps.length > 0);
  assert.ok(mixed.sleepSpanningGaps.every((gap) => gap.excludedSleepMs === 60 * 60_000 &&
    gap.rawGapMs - gap.eligibleGapMs === gap.excludedSleepMs));
  assert.ok(report.cohorts.every((item) => item.resumeDelayMs === null || item.resumeDelayMs <= 60_000));
  assert.ok(report.cohorts.every((item) => item.paneCoverage.length === item.panes &&
    item.paneCoverage.every((pane) => pane.successes > 0)));
  assert.ok(report.cohorts.some((item) => item.duplicateRepositories));
  assert.deepEqual(new Set(report.cohorts.flatMap((item) => item.tabs)),
    new Set(["actions", "issues", "prs", "security"]));
});
