import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  compareStartupSlice,
  efficiencyReleaseGate,
  evaluateEligibleQueryGaps,
  formatEfficiencyMarkdown,
  runEfficiencyMeasurement,
} from "../scripts/measure-efficiency.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const WORKLOAD_PATH = join(ROOT, "fixtures/workloads/multi-instance-v1.json");
const BASELINE_PATH = join(ROOT,
  "../docs/plans/2026-09-05-multi-instance-efficiency-phases/phase-1-baseline.json");
const WORKLOAD = JSON.parse(readFileSync(WORKLOAD_PATH, "utf8"));
const SUSTAINED = WORKLOAD.scenarios.find(({ id }) => id === "sustained-hour");

test("one starved query fails per-query freshness even when the other samples pass", () => {
  const at = 1_800_000_000_000;
  const query = (repository, observations) => ({
    repository, resource: "actions", eligibleAt: at, observations,
  });
  const success = (offset, generation) => ({
    lastSuccessAt: at + offset, nextDueAt: at + offset + 5_000, generation,
    status: generation === 1 ? 200 : 304,
  });
  const result = evaluateEligibleQueryGaps([
    query("acme/fast", [success(100, 1), success(5_100, 2), success(10_100, 3),
      success(15_100, 4), success(20_100, 5), success(25_100, 6),
      success(30_100, 7), success(35_100, 8)]),
    query("acme/starved", [success(100, 1)]),
  ], { endAt: at + 40_000, floorMs: 5_000 });
  assert.equal(result.passed, false);
  assert.equal(result.queries.length, 2);
  assert.equal(result.queries[0].passed, true);
  assert.equal(result.queries[0].firstSuccessDelayMs, 100);
  assert.equal(result.worst.repository, "acme/starved");
  assert.ok(result.worst.maxOverdueMs > 15_000);
  assert.match(result.worst.trace.join(" -> "), /generation 1/);
});

test("foreground activation must get a new source success within 15 seconds", () => {
  const at = 1_800_000_000_000;
  const result = evaluateEligibleQueryGaps([{
    repository: "acme/background", resource: "prs", eligibleAt: at,
    firstPolicyMs: 120_000, activations: [at + 30_000],
    observations: [{ lastSuccessAt: at + 100, nextDueAt: at + 120_100,
      generation: 1, status: 200 }],
  }], { endAt: at + 50_000, floorMs: 5_000 });
  assert.equal(result.passed, false);
  assert.match(result.worst.trace.join(" -> "), /foreground activation/);
  assert.equal(result.worst.maxOverdueMs, 20_000);
});

test("an observer outage excludes time only when injected and reported", () => {
  const at = 1_800_000_000_000;
  const query = (reported) => ({
    repository: "acme/widget", resource: "issues", eligibleAt: at,
    observations: [{ lastSuccessAt: at + 100, nextDueAt: at + 5_100,
      generation: 1, status: 200 },
    { lastSuccessAt: at + 45_100, nextDueAt: at + 50_100,
      generation: 2, status: 200 }],
    holds: [{ startAt: at + 10_000, endAt: at + 40_000,
      injected: true, reported }],
  });
  assert.equal(evaluateEligibleQueryGaps([query(false)],
    { endAt: at + 50_000 }).passed, false);
  assert.equal(evaluateEligibleQueryGaps([query(true)],
    { endAt: at + 50_000 }).passed, true);
});

test("overlapping reported holds exclude their union only once", () => {
  const at = 1_800_000_000_000;
  const hold = { startAt: at + 10_000, endAt: at + 20_000,
    injected: true, reported: true };
  const query = (holds) => ({
    repository: "acme/widget", resource: "issues", eligibleAt: at,
    observations: [
      { lastSuccessAt: at + 100, nextDueAt: at + 5_100, generation: 1, status: 200 },
      { lastSuccessAt: at + 40_100, nextDueAt: at + 45_100, generation: 2, status: 304 },
    ],
    holds,
  });
  const single = evaluateEligibleQueryGaps([query([hold])], { endAt: at + 45_100 });
  const repeated = evaluateEligibleQueryGaps([query([hold, { ...hold }])],
    { endAt: at + 45_100 });
  assert.equal(single.passed, false);
  assert.equal(repeated.passed, false);
  assert.equal(repeated.worst.maxOverdueMs, single.worst.maxOverdueMs);
  assert.equal(repeated.worst.maxOverdueMs, 25_000);
});

test("E2E-03/05: sustained fixture declares every deterministic disruption and topology", () => {
  assert.equal(SUSTAINED.durationMs, 60 * 60 * 1000);
  assert.deepEqual(SUSTAINED.topologies.map(({ id }) => id), [
    "single-pane", "two-duplicates", "seven-duplicates", "ten-duplicates",
    "ten-distinct", "mixed-tabs", "two-machines",
  ]);
  assert.deepEqual(new Set(SUSTAINED.timeline.map(({ type }) => type)), new Set([
    "change", "externalSpend", "secondaryHold", "primaryReset", "producerLoss",
    "forceRefresh", "accountSwitch", "recovery",
  ]));
  assert.equal(SUSTAINED.publishedProbes.graphql.mode, "pinned");
  assert.equal(SUSTAINED.responseCounters, "independent");
  const mixed = SUSTAINED.topologies.find(({ id }) => id === "mixed-tabs");
  assert.equal(mixed.subscribers.length, 8);
  assert.equal(mixed.subscribers.filter(({ active }) => active).length, 4);
  assert.deepEqual(new Set(mixed.subscribers.map(({ resource }) => resource)),
    new Set(["actions", "issues", "prs", "security"]));
  assert.equal(mixed.demandChanges.length, 2);
  assert.deepEqual(mixed.events.map(({ type, resource }) => [type, resource]), [
    ["observerFailure", "core"], ["observerFailure", "graphql"],
  ]);
});

test("E2E-02/03/04/05: accelerated hour uses production coordination and reconciles oracle truth", async () => {
  const report = await runEfficiencyMeasurement({
    workloadPath: WORKLOAD_PATH,
    baselinePath: BASELINE_PATH,
    includeResources: false,
    includeStartupSlice: false,
    topologyIds: SUSTAINED.topologies.map(({ id }) => id).filter((id) => id !== "mixed-tabs"),
  });

  assert.equal(report.kind, "deterministic-efficiency-measurement");
  assert.equal(report.workload.simulatedDurationMs, 60 * 60 * 1000);
  assert.equal(report.correctness.duplicateProducerPerGeneration, 0);
  assert.equal(report.correctness.remoteClientGithubRequests, 0);
  assert.equal(report.correctness.producerLossRecovered, true);
  assert.equal(report.correctness.accountSwitchIsolated, true);
  assert.equal(report.correctness.progressAfterReset, true);
  assert.equal(report.correctness.secondaryHoldObserved, true);
  assert.equal(report.correctness.producerLossRetainedUncertainty, true);
  assert.equal(report.correctness.staleCompletionFenced, true);
  assert.equal(report.correctness.accessPartitionIsolated, true);
  assert.equal(report.correctness.securityCapabilityTruth, true);
  assert.equal(report.correctness.restartRetention, true);
  assert.equal(report.correctness.reconnectAgeNonRegressing, true);
  assert.equal(report.correctness.pinnedGraphqlProbeStable, true);
  for (const topology of report.topologies) {
    assert.equal(topology.pinnedGraphqlProbe.graphqlObserverCalls, 0,
      `${topology.id} must not probe GraphQL for an Actions-only cost vector`);
    assert.equal(topology.pinnedGraphqlProbe.actualUsed,
      topology.pinnedGraphqlProbe.witnessedGraphqlCost,
      `${topology.id} GraphQL use must match charged oracle operations`);
    assert.ok(topology.minimumCoreRemaining >= 1_000,
      `${topology.id} must preserve the core reserve`);
  }
  assert.equal(report.correctness.reserveBoundaryApproached, true);
  assert.equal(report.correctness.reserveCrossingRefused, true);
  assert.deepEqual(report.correctness.reserveBoundary, {
    coreRemaining: 1000,
    requestedCoreUnits: 1,
    status: "paused",
    reason: "reserve",
    refused: true,
  });
  assert.ok(report.correctness.minimumCoreRemaining >= 1000);
  assert.ok(report.correctness.minimumGraphqlRemaining >= 1000);
  assert.deepEqual(report.correctness.e2e4Combinations, {
    standalone: true,
    localCollector: true,
    sshClients: true,
    webhookInvalidation: true,
    githubAppProvider: true,
  });

  const identical = report.topologies.find(({ id }) => id === "ten-duplicates");
  const distinct = report.topologies.find(({ id }) => id === "ten-distinct");
  const remote = report.topologies.find(({ id }) => id === "two-machines");
  assert.equal(identical.attributableStreams, 1);
  assert.equal(identical.maximumProducersPerGeneration, 1);
  assert.equal(identical.coalescedConsumers, 10);
  assert.equal(distinct.attributableStreams, 10);
  const progress = Object.values(distinct.repositoryProgress);
  assert.equal(progress.length, 10);
  for (const repository of progress) {
    assert.ok(repository.dueGenerations > 0);
    assert.ok(repository.requests > 0);
    assert.ok(repository.successes > 0);
    assert.ok(repository.postHoldSuccesses > 0);
    assert.ok(repository.postResetSuccesses > 0);
  }
  for (const metric of ["dueGenerations", "requests", "successes", "postHoldSuccesses",
    "postResetSuccesses"]) {
    const values = progress.map((repository) => repository[metric]);
    assert.ok(Math.max(...values) - Math.min(...values) <= 2,
      `${metric} progress must remain fair across canonical repositories`);
  }
  assert.deepEqual(remote.clientsByRoot, [3, 4]);
  assert.equal(remote.clientGithubRequests, 0);
  assert.equal(remote.clientRoots, 2);
  assert.equal(remote.collectorStreams, 1);
  assert.equal(remote.collectorDeliveries, 7);
  assert.equal(remote.transport, "service+stdio+fake-ssh");
  assert.equal(remote.clientProcessStarts, 7);
  assert.equal(remote.sshOnly, true);

  assert.ok(report.metrics.httpRequests > 0);
  assert.equal(report.metrics.httpRequests,
    report.metrics.dataHttpRequests + report.metrics.observerCalls);
  assert.ok(report.metrics.rest200 > 0);
  assert.ok(report.metrics.rest304 > 0);
  assert.equal(report.metrics.graphqlUnits, 0,
    "Actions-only topologies must not spend GraphQL budget");
  assert.ok(report.metrics.observerCalls > 0);
  assert.ok(report.metrics.provenCoreUnits > 0);
  assert.ok(report.metrics.uncertainCoreUnits > 0);
  assert.equal(report.metrics.costEvidence.oracleCharged, true);
  assert.equal(report.metrics.costEvidence.acquisitionPersisted, true);
  assert.ok(report.metrics.maximumConcurrentProducerRequests >= 1);
  assert.ok(report.metrics.coalescedConsumers >= 10);
  assert.ok(report.freshness.sourceToDisplayMs.samples > 0);
  assert.ok(report.freshness.sourceToDisplayMs.p95 <= SUSTAINED.targets.sourceToDisplayMs);
  assert.equal(report.queueDelayMs.kind, "shared-follower-delivery-after-producer-start");
  if (report.queueDelayMs.samples === 0) {
    assert.equal(report.queueDelayMs.p50, null);
    assert.equal(report.queueDelayMs.p95, null);
    assert.match(report.queueDelayMs.unavailableReason, /no separate follower callback/i);
  } else {
    assert.ok(report.queueDelayMs.p95 >= 0);
    assert.ok(report.queueDelayMs.p95 <= SUSTAINED.targets.followerDeliveryMs);
  }
  assert.equal(report.resources.subprocessCount, 7);

  assert.equal(report.baselineComparison.status, "incompatible");
  assert.equal(report.baselineComparison.improvementPercent, null);
  assert.ok(report.baselineComparison.reasons.includes("workload"));
  assert.match(formatEfficiencyMarkdown(report), /Baseline comparison: incompatible/);
  assert.match(formatEfficiencyMarkdown(report), /not claimed/i);
  assert.match(formatEfficiencyMarkdown(report), /Oracle charged cost:/);
  assert.match(formatEfficiencyMarkdown(report), /Acquisition proven\/uncertain cost:/);
  assert.match(formatEfficiencyMarkdown(report), /Shared follower-delivery delay/);
  assert.deepEqual(report.releaseGate, { passed: false, reason: "startup-slice-not-measured" });
});

test("E2E-03: resource-disabled measurement is identical across three bounded runs", {
  timeout: 120_000,
}, async () => {
  const stable = (report) => {
    const copy = structuredClone(report);
    delete copy.resources.wallTimeMs;
    delete copy.resources.sampledCpuSeconds;
    delete copy.resources.peakSampledRssKiB;
    return copy;
  };
  const reports = [];
  for (let run = 0; run < 3; run += 1) {
    reports.push(stable(await runEfficiencyMeasurement({
      workloadPath: WORKLOAD_PATH,
      baselinePath: BASELINE_PATH,
      includeResources: false,
      includeStartupSlice: false,
      // The full mixed cohort runs once in the acceptance case above; this
      // repeatability check keeps its bounded 120-second gate.
      topologyIds: SUSTAINED.topologies.map(({ id }) => id).filter((id) => id !== "mixed-tabs"),
    })));
  }
  assert.deepEqual(reports[1], reports[0]);
  assert.deepEqual(reports[2], reports[0]);
});

test("E2E-05: mixed-pane hour enforces each canonical query's eligible gap", {
  timeout: 360_000,
}, async () => {
  const report = await runEfficiencyMeasurement({
    workloadPath: WORKLOAD_PATH,
    baselinePath: BASELINE_PATH,
    includeResources: false,
    includeStartupSlice: false,
    topologyIds: ["mixed-tabs"],
  });
  const mixed = report.topologies[0];
  assert.deepEqual(new Set(mixed.queryFreshness.queries.map(({ resource }) => resource)),
    new Set(["actions", "issues", "prs", "security"]));
  assert.equal(mixed.queryFreshness.queries.length, 7);
  assert.ok(mixed.queryFreshness.queries.every(({ successes }) => successes > 0));
  assert.ok(mixed.queryFreshness.queries.some(({ resource, response200, response304 }) =>
    resource === "actions" && response200 > 0 && response304 > 0));
  assert.equal(mixed.queryFreshness.passed, true,
    JSON.stringify(mixed.queryFreshness.worst));
  assert.ok(report.metrics.graphqlUnits > 0,
    "mixed Issues and PRs queries must account for GraphQL cost");
  for (const resource of ["core", "graphql"]) {
    assert.equal(mixed.observerFailures[resource].observed, 1, resource);
    assert.equal(mixed.observerFailures[resource].reportedHold, true, resource);
    assert.ok(mixed.observerFailures[resource].excludedWindow.endAt >
      mixed.observerFailures[resource].excludedWindow.startAt, resource);
    assert.equal(mixed.observerFailures[resource].postFailureValidatedSourceSuccess, true, resource);
    assert.ok(mixed.observerFailures[resource].postRecoveryDelayMs <= 15_000, resource);
    assert.equal(mixed.observerFailures[resource].observerHealthyAtEnd, true, resource);
  }
  assert.equal(report.freshness.eligibleQueryGaps.passed, true);
  assert.match(formatEfficiencyMarkdown(report), /Eligible query maximum overdue/);
});

test("E2E-05: Phase 1 startup metrics compare only under the exact capture identity", () => {
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  const current = structuredClone(baseline);
  current.samples = current.samples.map((sample) => ({
    ...sample,
    actionsRunRequests: sample.distinct || sample.panes === 1 ? sample.actionsRunRequests : 1,
  }));
  const compatible = compareStartupSlice(baseline, current);
  assert.equal(compatible.status, "compatible");
  assert.ok(compatible.improvementPercent > 0);
  assert.ok(compatible.samples.every(({ status }) => status === "comparable"));
  assert.match(compatible.unavailable.sourceToDisplayLatency, /no source changes/i);
  assert.equal(compatible.samples[0].metrics.actionsRunRequests.status, "comparable");

  const wrongRuntime = compareStartupSlice(baseline, { ...current, runtime: "v22.0.0" });
  assert.equal(wrongRuntime.status, "incompatible");
  assert.deepEqual(wrongRuntime.reasons, ["runtime"]);
  assert.equal(wrongRuntime.improvementPercent, null);
  assert.deepEqual(wrongRuntime.samples, []);

  assert.deepEqual(efficiencyReleaseGate(compatible), { passed: true, reason: "positive-request-improvement" });
  assert.deepEqual(efficiencyReleaseGate(wrongRuntime), { passed: false, reason: "incompatible-startup-slice" });
  assert.deepEqual(efficiencyReleaseGate({ ...compatible, improvementPercent: 0 }),
    { passed: false, reason: "non-positive-request-improvement" });
});
