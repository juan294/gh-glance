import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { acquisitionStorePath, createAcquisitionEngine, emptyGovernorState } from "../index.mjs";
import { createFreshnessMonitor, main } from "../scripts/freshness-monitor.mjs";
import { createOracleState, handleOracleRequest } from "./fixtures/request-oracle.mjs";

const AT = 1_800_000_000_000;
const SECRET = "private/acme-repository";
const QUERY_KEY = "sensitive-query-key";
const CANDIDATE_HASH = "a".repeat(64);
const ACCESS_IDENTITY = "b".repeat(64);
const quota = { ok: true, value: { observers: { core: { outcome: "success", nextAt: AT + 60_000 },
  graphql: { outcome: "success", nextAt: AT + 60_000 } },
debt: { core: { unresolvedUnits: 1, quiescentUnits: 0 },
  graphql: { unresolvedUnits: 0, quiescentUnits: 0 } } } };
const quotaOptions = { quotaPath: "/unused/quota.json", readQuota: () => quota,
  verifyQuotaScope: () => true, isPidAlive: () => "live" };
const manifest = (panes = [
  { id: "first pane", pid: 201, repository: SECRET, tab: "actions", startedAt: AT, cadenceMs: 5_000 },
]) => ({ schema: 1, panes });

function store(successAt = null, changedAt = successAt, expiresAt = AT + 120_000) {
  return { ok: true, value: {
    subscriptions: {
      a: { pid: 201, queryKey: QUERY_KEY, expiresAt, demand: { active: false, floorMs: 5_000 } },
      b: { pid: 202, queryKey: QUERY_KEY, expiresAt, demand: { active: true, floorMs: 5_000 } },
    },
    queries: { [QUERY_KEY]: {
      query: { queryKey: QUERY_KEY, repository: SECRET, resource: "actions", host: "github.com",
        accessKey: ACCESS_IDENTITY },
      snapshot: successAt === null ? null : {
        lastSuccessAt: successAt, lastChangedAt: changedAt, nextDueAt: successAt + 5_000,
        generation: 1,
      },
      hold: null,
    } },
  } };
}

const qualificationManifest = (overrides = {}) => ({ schema: 2,
  candidateHash: CANDIDATE_HASH, requestedDurationMs: 20_000, sampleIntervalMs: 5_000,
  panes: [{ id: "first pane", pid: 201, repository: SECRET, repositoryId: "R_secret",
    host: "github.com", accessKey: ACCESS_IDENTITY, tab: "actions", startedAt: AT,
    cadenceMs: 5_000 }], ...overrides });

test("qualification rejects a mismatched candidate and a cohort identity substitution", () => {
  assert.throws(() => createFreshnessMonitor({ manifest: qualificationManifest(),
    candidateHash: "c".repeat(64), storePath: "/unused/acquisition.json" }), /candidate/i);
  const monitor = createFreshnessMonitor({ manifest: qualificationManifest(),
    candidateHash: CANDIDATE_HASH, storePath: "/unused/acquisition.json",
    ...quotaOptions,
    now: () => AT + 1_000, monotonicNow: () => 1_000,
    readStore: () => store(AT + 1_000),
    inspectLock: () => ({ status: "unobstructed", ageMs: null }) });
  assert.equal(monitor.sample().panes[0].state, "missing-subscription");
  assert.equal(monitor.summary().ok, false);
});

test("window class is derived from requested duration and never claims Phase 4 completion", () => {
  for (const [duration, expected] of [[1_000, "short"], [30 * 60_000, "initial"],
    [24 * 60 * 60_000, "full"]]) {
    const monitor = createFreshnessMonitor({ manifest: qualificationManifest({
      requestedDurationMs: duration,
    }), candidateHash: CANDIDATE_HASH, storePath: "/unused/acquisition.json",
    ...quotaOptions });
    assert.equal(monitor.summary().windowClass, expected);
    assert.equal(monitor.summary().ok, false);
  }
});

test("an expected pane that starts after the first sample fails cohort coverage", () => {
  const monitor = createFreshnessMonitor({ manifest: qualificationManifest({
    panes: [{ ...qualificationManifest().panes[0], startedAt: AT + 1_000 }],
  }), candidateHash: CANDIDATE_HASH, storePath: "/unused/acquisition.json",
  ...quotaOptions, now: () => AT, monotonicNow: () => 0,
  readStore: () => store(AT), inspectLock: () => ({ status: "unobstructed", ageMs: null }) });
  assert.equal(monitor.sample().panes[0].state, "not-started");
  assert.equal(monitor.summary().ok, false);
  assert.equal(monitor.summary().panes[0].failed, true);
});

test("future and regressing source clocks fail independent qualification", () => {
  for (const [initialSuccess, initialChanged, nextSuccess, nextChanged, nextNow,
    expectedState] of [
    [AT, AT, AT + 5_000, AT, AT, "future-success"],
    [AT + 1_000, AT - 1_000, AT, AT - 1_000, AT + 5_000, "regressed-success"],
    [AT, AT, AT + 5_000, AT - 1, AT + 5_000, "invalid-source-clock"],
  ]) {
    let at = Math.max(AT, initialSuccess);
    const current = store(initialSuccess, initialChanged);
    current.value.queries[QUERY_KEY].query.repositoryId = "R_secret";
    const monitor = createFreshnessMonitor({ manifest: qualificationManifest(),
      candidateHash: CANDIDATE_HASH, storePath: "/unused/acquisition.json",
      ...quotaOptions, now: () => at, monotonicNow: () => at - AT,
      readStore: () => current,
      inspectLock: () => ({ status: "unobstructed", ageMs: null }) });
    assert.equal(monitor.sample().ok, true);
    at = nextNow;
    Object.assign(current.value.queries[QUERY_KEY].snapshot, {
      lastSuccessAt: nextSuccess, lastChangedAt: nextChanged, generation: 2,
    });
    assert.equal(monitor.sample().panes[0].state, expectedState);
    assert.equal(monitor.summary().ok, false);
  }
});

test("qualification uses declared cadence despite a far-future production nextDueAt", () => {
  let at = AT;
  const current = store(AT);
  current.value.queries[QUERY_KEY].query.repositoryId = "R_secret";
  current.value.queries[QUERY_KEY].snapshot.nextDueAt = AT + 86_400_000;
  const monitor = createFreshnessMonitor({ manifest: qualificationManifest(),
    candidateHash: CANDIDATE_HASH, storePath: "/unused/acquisition.json",
    ...quotaOptions,
    now: () => at, monotonicNow: () => at - AT,
    readStore: () => current, inspectLock: () => ({ status: "unobstructed", ageMs: null }) });
  monitor.sample();
  for (at of [AT + 5_000, AT + 10_000, AT + 15_000, AT + 20_001]) monitor.sample();
  assert.equal(monitor.summary().ok, false);
  assert.equal(monitor.summary().panes[0].maxOverdueMs, 1);
});

test("an active pane gets a 60-second observation deadline after background reactivation", () => {
  let at = AT;
  const current = store(AT);
  current.value.queries[QUERY_KEY].query.repositoryId = "R_secret";
  current.value.queries[QUERY_KEY].snapshot.nextDueAt = AT + 86_400_000;
  const monitor = createFreshnessMonitor({ manifest: qualificationManifest({
    requestedDurationMs: 90_000,
    panes: [{ ...qualificationManifest().panes[0], cadenceMs: 120_000 }],
  }),
    candidateHash: CANDIDATE_HASH, storePath: "/unused/acquisition.json", ...quotaOptions,
    now: () => at, monotonicNow: () => at - AT,
    readStore: () => current, inspectLock: () => ({ status: "unobstructed", ageMs: null }) });
  monitor.sample();
  for (at = AT + 5_000; at <= AT + 30_000; at += 5_000) monitor.sample();
  at = AT + 30_000;
  current.value.subscriptions.a.demand.active = true;
  assert.equal(monitor.sample().panes[0].state, "eligible");
  for (at = AT + 35_000; at <= AT + 90_000; at += 5_000) {
    assert.equal(monitor.sample().ok, true);
  }
  at = AT + 90_001;
  assert.equal(monitor.sample().panes[0].state, "overdue");
  assert.equal(monitor.summary().ok, false);
});

test("first source deadline respects background cadence while active remains 60 seconds", () => {
  for (const [active, cadenceMs, expected] of [
    [true, 30_000, "overdue"],
    [false, 120_000, "awaiting-first"],
    [false, 300_000, "awaiting-first"],
  ]) {
    let at = AT + 60_001;
    const current = store(null, null, AT + 1_000_000);
    current.value.queries[QUERY_KEY].query.repositoryId = "R_secret";
    current.value.subscriptions.a.demand.active = active;
    const monitor = createFreshnessMonitor({ manifest: qualificationManifest({
      panes: [{ ...qualificationManifest().panes[0], cadenceMs }],
    }), candidateHash: CANDIDATE_HASH, storePath: "/unused/acquisition.json",
    ...quotaOptions, now: () => at, monotonicNow: () => at - AT,
    readStore: () => current,
    inspectLock: () => ({ status: "unobstructed", ageMs: null }) });
    assert.equal(monitor.sample().panes[0].state, expected);
    if (!active) {
      at = AT + cadenceMs + Math.max(2 * cadenceMs, 15_000) + 1;
      assert.equal(monitor.sample().panes[0].state, "overdue");
    }
  }
});

test("quota read uses the clock after acquisition hydration", () => {
  let at = AT;
  const current = store(AT);
  current.value.queries[QUERY_KEY].query.repositoryId = "R_secret";
  const monitor = createFreshnessMonitor({ manifest: qualificationManifest(),
    candidateHash: CANDIDATE_HASH, storePath: "/unused/acquisition.json",
    quotaPath: "/unused/quota.json", verifyQuotaScope: () => true,
    isPidAlive: () => "live", now: () => at, monotonicNow: () => at - AT,
    readStore: () => { at += 100; return current; },
    readQuota: (_path, observedAt) => observedAt >= AT + 100
      ? quota : { ok: false, reason: "future-clock" },
    inspectLock: () => ({ status: "unobstructed", ageMs: null }) });
  assert.equal(monitor.sample().diagnostics.status, "available");
});

test("a publication during hydration is not a future source timestamp", () => {
  let at = AT;
  const current = store(AT + 100, AT + 100);
  current.value.queries[QUERY_KEY].query.repositoryId = "R_secret";
  current.value.subscriptions.a.demand.active = true;
  const monitor = createFreshnessMonitor({ manifest: qualificationManifest(),
    candidateHash: CANDIDATE_HASH, storePath: "/unused/acquisition.json",
    ...quotaOptions, now: () => at, monotonicNow: () => at - AT,
    readStore: () => { at += 100; return current; },
    inspectLock: () => ({ status: "unobstructed", ageMs: null }) });
  const sample = monitor.sample();
  assert.equal(sample.panes[0].state, "eligible");
  assert.equal(sample.at, AT);
  assert.equal(sample.sourceReadAt, AT + 100);
  assert.ok(sample.panes[0].lastSuccessAt <= sample.sourceReadAt);
});

test("a complete uninterrupted qualification window passes with new source generations", () => {
  let at = AT;
  const current = store(AT);
  current.value.queries[QUERY_KEY].query.repositoryId = "R_secret";
  const monitor = createFreshnessMonitor({ manifest: qualificationManifest(),
    candidateHash: CANDIDATE_HASH, storePath: "/unused/acquisition.json", ...quotaOptions,
    now: () => at, monotonicNow: () => at - AT,
    readStore: () => current, inspectLock: () => ({ status: "unobstructed", ageMs: null }) });
  for (let generation = 1; generation <= 5; generation += 1) {
    at = AT + (generation - 1) * 5_000;
    Object.assign(current.value.queries[QUERY_KEY].snapshot, { generation,
      lastSuccessAt: at, lastChangedAt: AT });
    assert.equal(monitor.sample().ok, true);
  }
  const summary = monitor.summary();
  assert.equal(summary.ok, true);
  assert.equal(summary.actualElapsedMs, 20_000);
  assert.equal(summary.uninterruptedMs, 20_000);
  assert.equal(summary.panes[0].successes, 5);
});

test("new source success may retain content changed before the pane started", () => {
  const current = store(AT + 1_000, AT - 86_400_000);
  current.value.queries[QUERY_KEY].query.repositoryId = "R_secret";
  const monitor = createFreshnessMonitor({ manifest: qualificationManifest(),
    candidateHash: CANDIDATE_HASH, storePath: "/unused/acquisition.json", ...quotaOptions,
    now: () => AT + 1_000, monotonicNow: () => 1_000,
    readStore: () => current, inspectLock: () => ({ status: "unobstructed", ageMs: null }) });
  assert.equal(monitor.sample().panes[0].state, "eligible");
  assert.equal(monitor.summary().panes[0].successes, 1);
});

test("an appended response trace can account for a later provider hold but prior edits fail", () => {
  let at = AT;
  const current = store(AT);
  current.value.queries[QUERY_KEY].query.repositoryId = "R_secret";
  const monitor = createFreshnessMonitor({ manifest: qualificationManifest(),
    candidateHash: CANDIDATE_HASH, storePath: "/unused/acquisition.json", ...quotaOptions,
    now: () => at, monotonicNow: () => at - AT,
    readStore: () => current, inspectLock: () => ({ status: "unobstructed", ageMs: null }) });
  monitor.sample();
  const captured = { type: "raw-http", host: "github.com", accessKey: ACCESS_IDENTITY,
    resource: "core", issuedAt: AT + 4_900, finishedAt: AT + 5_000,
    response: "HTTP/2 429 Too Many Requests\r\nx-ratelimit-resource: core\r\nretry-after: 20\r\n\r\n" };
  assert.throws(() => monitor.updateExternalEvidence([captured]), /captured provider response/,
    "a future response cannot predeclare an outage");
  at = AT + 5_000;
  monitor.updateExternalEvidence([captured]);
  for (at of [AT + 5_000, AT + 10_000, AT + 15_000, AT + 20_000]) {
    assert.equal(monitor.sample().ok, true);
  }
  assert.equal(monitor.summary().externalOutageMs, 15_000);
  assert.throws(() => monitor.updateExternalEvidence([{ ...captured,
    response: captured.response.replace("20", "30") }]), /changed earlier evidence/);
});

test("undefined source timestamps and a mismatched quota registry fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-monitor-scope-"));
  try {
    const current = store(AT);
    current.value.queries[QUERY_KEY].query.repositoryId = "R_secret";
    current.value.queries[QUERY_KEY].snapshot.lastChangedAt = undefined;
    const quotaPath = join(root, `quota-${"c".repeat(64)}.json`);
    writeFileSync(join(root, "registry.json"), JSON.stringify({ identities: {
      other: { host: "github.com", accessKey: "d".repeat(64), quotaKey: "c".repeat(64) },
    } }));
    const monitor = createFreshnessMonitor({ manifest: qualificationManifest(),
      candidateHash: CANDIDATE_HASH, storePath: "/unused/acquisition.json",
      quotaPath, readQuota: () => quota, isPidAlive: () => "live",
      now: () => AT, monotonicNow: () => 0,
      readStore: () => current, inspectLock: () => ({ status: "unobstructed", ageMs: null }) });
    const sample = monitor.sample();
    assert.equal(sample.panes[0].state, "invalid-source-clock");
    assert.equal(sample.diagnostics.status, "unavailable");
    assert.equal(sample.ok, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a declared pane disappears even while its subscription is unexpired", () => {
  let alive = true;
  let at = AT;
  const current = store(AT);
  current.value.queries[QUERY_KEY].query.repositoryId = "R_secret";
  const monitor = createFreshnessMonitor({ manifest: qualificationManifest(),
    candidateHash: CANDIDATE_HASH, storePath: "/unused/acquisition.json",
    ...quotaOptions, isPidAlive: () => alive ? "live" : "dead",
    now: () => at, monotonicNow: () => at - AT,
    readStore: () => current, inspectLock: () => ({ status: "unobstructed", ageMs: null }) });
  assert.equal(monitor.sample().ok, true);
  alive = false;
  at += 5_000;
  assert.equal(monitor.sample().panes[0].state, "pane-disappeared");
  assert.equal(monitor.summary().ok, false);
});

test("qualification fails missing samples, clock rollback, and an incomplete window", () => {
  let at = AT;
  let mono = 0;
  const current = store(AT);
  current.value.queries[QUERY_KEY].query.repositoryId = "R_secret";
  const monitor = createFreshnessMonitor({ manifest: qualificationManifest(),
    candidateHash: CANDIDATE_HASH, storePath: "/unused/acquisition.json",
    ...quotaOptions,
    now: () => at, monotonicNow: () => mono,
    readStore: () => current, inspectLock: () => ({ status: "unobstructed", ageMs: null }) });
  monitor.sample();
  assert.equal(monitor.summary().ok, false, "an early stop cannot qualify");
  at += 20_000; mono += 20_000;
  current.value.queries[QUERY_KEY].snapshot.lastSuccessAt = at;
  monitor.sample();
  assert.equal(monitor.summary().coverageGaps, 1);
  assert.equal(monitor.summary().ok, false);
  at -= 1_000; mono += 5_000;
  assert.equal(monitor.sample().ok, false);
  assert.equal(monitor.summary().clockFaults > 0, true);
});

test("qualification does not exclude a claimed observer hold; independent provider evidence is scoped", () => {
  let at = AT;
  const current = store(AT);
  current.value.queries[QUERY_KEY].query.repositoryId = "R_secret";
  const hold = { reason: "observer", at: AT + 5_000 };
  const make = (externalEvidence = []) => createFreshnessMonitor({
    manifest: qualificationManifest(), candidateHash: CANDIDATE_HASH,
    ...quotaOptions,
    externalEvidence, storePath: "/unused/acquisition.json", now: () => at,
    monotonicNow: () => at - AT, readStore: () => current,
    inspectLock: () => ({ status: "unobstructed", ageMs: null }) });
  const forged = make();
  forged.sample();
  at += 5_000; current.value.queries[QUERY_KEY].hold = hold;
  forged.sample();
  for (at of [AT + 10_000, AT + 15_000, AT + 20_001]) forged.sample();
  assert.equal(forged.summary().ok, false);
  assert.equal(forged.summary().externalOutageMs, 0);
  const oracle = createOracleState({ now: AT });
  oracle.credentials["fixture-full"].accessKey = ACCESS_IDENTITY;
  oracle.scriptedEvents.push({ type: "throttle", at: AT + 5_000,
    operation: "actions.runs", durationMs: 20_000 });
  const response = handleOracleRequest(oracle, { argv: ["api", "-i",
    `repos/${SECRET}/actions/runs?per_page=60&page=1`], now: AT + 5_000 });
  assert.equal(response.status, 429);
  assert.throws(() => make([{ type: "provider-rejection", host: "github.com",
    accessKey: ACCESS_IDENTITY, resource: "core", from: AT + 5_000,
    until: AT + 25_000, status: 429, headers: response.headers }]), /captured provider response/);
  assert.throws(() => make(oracle.events), /captured provider response/,
    "synthetic request-oracle records cannot qualify an outage");
  at = AT;
  current.value.queries[QUERY_KEY].hold = null;
  const captured = make();
  captured.sample();
  at = AT + 5_000;
  captured.updateExternalEvidence([{ type: "raw-http", host: "github.com", accessKey: ACCESS_IDENTITY,
    resource: "core", issuedAt: AT + 4_900, finishedAt: AT + 5_000,
    response: "HTTP/2 429 Too Many Requests\r\nx-ratelimit-resource: core\r\nretry-after: 20\r\n\r\n" }]);
  current.value.queries[QUERY_KEY].hold = { reason: "primary", at: AT + 5_000 };
  for (at of [AT + 5_000, AT + 10_000, AT + 15_000, AT + 20_000]) captured.sample();
  assert.equal(captured.summary().externalOutageMs, 15_000);
  assert.deepEqual(captured.summary().externalEvidenceSources, ["raw-provider-response"]);
  assert.equal(captured.summary().ok, true);
});

test("a brief local observer hold fails qualification even before source is overdue", () => {
  let at = AT;
  const current = store(AT);
  current.value.queries[QUERY_KEY].query.repositoryId = "R_secret";
  const monitor = createFreshnessMonitor({ manifest: qualificationManifest(),
    candidateHash: CANDIDATE_HASH, storePath: "/unused/acquisition.json",
    ...quotaOptions, now: () => at, monotonicNow: () => at - AT,
    readStore: () => current,
    inspectLock: () => ({ status: "unobstructed", ageMs: null }) });
  assert.equal(monitor.sample().ok, true);
  at += 5_000;
  current.value.queries[QUERY_KEY].hold = { reason: "observer", at };
  assert.equal(monitor.sample().ok, false);
  at += 5_000;
  current.value.queries[QUERY_KEY].hold = null;
  monitor.sample();
  assert.equal(monitor.summary().ok, false);
  assert.equal(monitor.summary().externalOutageMs, 0);
});

test("200 and unchanged-row 304 advance source success for duplicate panes without leaking identities", () => {
  let at = AT;
  let current = store();
  const lines = [];
  const monitor = createFreshnessMonitor({
    manifest: manifest([
      ...manifest().panes,
      { id: "second pane", pid: 202, repository: SECRET, tab: "actions", startedAt: AT,
        cadenceMs: 5_000 },
    ]), storePath: "/unused/acquisition.json", now: () => at,
    readStore: () => current, inspectLock: () => ({ status: "unobstructed", ageMs: null }),
    emit: (line) => lines.push(line),
  });
  assert.equal(monitor.sample().ok, true);
  at = AT + 3_000;
  current = store(at);
  assert.equal(monitor.sample().ok, true);
  at += 5_000;
  current = store(at, AT + 3_000);
  const observed = monitor.sample();
  assert.equal(observed.ok, true);
  assert.equal(observed.panes.length, 2);
  assert.ok(observed.panes.every((pane) => pane.lastSuccessAt === at &&
    pane.lastChangedAt === AT + 3_000 && pane.state === "eligible"));
  assert.ok(monitor.summary().panes.every((pane) => pane.successes === 2));
  const output = lines.join("\n");
  for (const secret of [SECRET, QUERY_KEY, "never-log-this-access-key", "first pane", "second pane"]) {
    assert.equal(output.includes(secret), false, secret);
  }
});

test("an active switch cannot inherit a distant background snapshot deadline", () => {
  let at = AT + 1_000;
  const current = store(at);
  const snapshot = current.value.queries[QUERY_KEY].snapshot;
  snapshot.nextDueAt = AT + 120_000;
  const monitor = createFreshnessMonitor({ manifest: manifest(), storePath: "/unused/acquisition.json",
    now: () => at, readStore: () => current,
    inspectLock: () => ({ status: "unobstructed", ageMs: null }), emit: () => {} });
  assert.equal(monitor.sample().panes[0].demand, "background");
  at = AT + 30_000;
  current.value.subscriptions.a.demand.active = true;
  assert.equal(monitor.sample().panes[0].state, "eligible");
  at = AT + 50_001;
  const overdue = monitor.sample();
  assert.equal(overdue.panes[0].demand, "active");
  assert.equal(overdue.panes[0].state, "overdue");
  assert.equal(overdue.panes[0].maxOverdueMs, 1);
  assert.equal(monitor.summary().ok, false);
});

test("a blocked lock is reported and a frozen store fails despite vanished live subscribers", () => {
  let at = AT + 1_000;
  const lines = [];
  const monitor = createFreshnessMonitor({ manifest: manifest(), storePath: "/unused/acquisition.json",
    now: () => at, readStore: () => store(AT, AT, AT + 2_000),
    inspectLock: () => ({ status: "busy", ageMs: 20_000 }), emit: (line) => lines.push(line) });
  const first = monitor.sample();
  assert.equal(first.ok, false);
  assert.equal(first.lock.status, "busy");
  assert.equal(monitor.summary().ok, false, "a blocked lock affects health even before source expiry");
  at = AT + 20_000;
  const frozen = monitor.sample();
  assert.equal(frozen.ok, false);
  assert.equal(frozen.panes[0].state, "missing-subscription");
  assert.equal(monitor.summary().ok, false);
  assert.match(lines.at(-1), /missing-subscription/);
});

test("a brief live lock is reported without failing health, but a sustained lock fails", () => {
  let at = AT + 1_000;
  let lock = { status: "busy", ageMs: 500 };
  const monitor = createFreshnessMonitor({ manifest: manifest(), storePath: "/unused/acquisition.json",
    now: () => at, readStore: () => store(AT), inspectLock: () => lock, emit: () => {} });
  assert.equal(monitor.sample().lock.healthy, true);
  at += 2_000;
  lock = { status: "busy", ageMs: 300 };
  assert.equal(monitor.sample().lock.healthy, true, "a new short transaction resets busy duration");
  at += 9_000;
  lock = { status: "busy", ageMs: 400 };
  assert.equal(monitor.sample().lock.healthy, true, "different short locks do not accumulate");
  at += 1_000;
  lock = { status: "unobstructed", ageMs: null };
  assert.equal(monitor.sample().ok, true);
  assert.equal(monitor.summary().ok, true);
  at += 1_000;
  lock = { status: "busy", ageMs: 500 };
  assert.equal(monitor.sample().lock.healthy, true);
  at += 11_000;
  lock = { status: "busy", ageMs: 11_500 };
  assert.equal(monitor.sample().lock.healthy, false);
  assert.equal(monitor.summary().ok, false);
});

test("a frozen validated source exceeds its due deadline; a named hold excludes only its interval", () => {
  let at = AT + 1_000;
  let current = store(at, at, AT + 120_000);
  const monitor = createFreshnessMonitor({ manifest: manifest([{ ...manifest().panes[0],
    holds: [{ reason: "secondary", from: AT + 21_001, until: AT + 52_001 }] }]),
    storePath: "/unused/acquisition.json",
    now: () => at, readStore: () => current,
    inspectLock: () => ({ status: "unobstructed", ageMs: null }), emit: () => {} });
  assert.equal(monitor.sample().panes[0].state, "eligible");
  at += 20_001;
  assert.equal(monitor.sample().panes[0].state, "overdue");
  assert.equal(monitor.summary().panes[0].maxOverdueMs, 1);
  current = store(at, AT + 1_000, AT + 120_000);
  current.value.queries[QUERY_KEY].hold = { reason: "secondary", at };
  at += 30_000;
  assert.equal(monitor.sample().panes[0].state, "held");
  current.value.queries[QUERY_KEY].hold = null;
  at += 1_000;
  assert.equal(monitor.sample().panes[0].state, "eligible");
  assert.deepEqual(monitor.summary().panes[0].holdIntervals,
    [{ reason: "secondary", from: AT + 21_001, until: at - 1_000 }]);
});

test("an early-cleared hold excludes only through its last observed sample", () => {
  let at = AT + 1_000;
  const current = store(at);
  const monitor = createFreshnessMonitor({ manifest: manifest([{ ...manifest().panes[0],
    holds: [{ reason: "secondary", from: AT + 20_000, until: AT + 60_000 }] }]),
    storePath: "/unused/acquisition.json", now: () => at, readStore: () => current,
    inspectLock: () => ({ status: "unobstructed", ageMs: null }), emit: () => {} });
  assert.equal(monitor.sample().panes[0].state, "eligible");
  at = AT + 21_000;
  current.value.queries[QUERY_KEY].hold = { reason: "secondary", at: AT + 20_000 };
  assert.equal(monitor.sample().panes[0].state, "held");
  at = AT + 47_000;
  current.value.queries[QUERY_KEY].hold = null;
  const released = monitor.sample();
  assert.equal(released.panes[0].state, "overdue");
  assert.equal(released.panes[0].maxOverdueMs, 6_000);
  assert.deepEqual(monitor.summary().panes[0].holdIntervals,
    [{ reason: "secondary", from: AT + 20_000, until: AT + 21_000 }]);
  assert.equal(monitor.summary().ok, false);
});

test("undeclared or mismatched runtime holds do not waive a stale source gap", () => {
  const at = AT + 30_000;
  const current = store(AT + 1_000);
  current.value.queries[QUERY_KEY].hold = { reason: "secondary", at: AT + 20_000 };
  const monitor = createFreshnessMonitor({ manifest: manifest([{ ...manifest().panes[0],
    holds: [{ reason: "primary", from: AT + 20_000, until: AT + 40_000 }] }]),
    storePath: "/unused/acquisition.json", now: () => at, readStore: () => current,
    inspectLock: () => ({ status: "unobstructed", ageMs: null }), emit: () => {} });
  assert.equal(monitor.sample().panes[0].state, "overdue");
  assert.deepEqual(monitor.summary().panes[0].holdIntervals, []);
});

test("a declared hold stops excluding at its declared end even if the runtime remains held", () => {
  let at = AT + 21_000;
  const current = store(AT + 1_000);
  current.value.queries[QUERY_KEY].hold = { reason: "secondary", at: AT + 20_000 };
  const monitor = createFreshnessMonitor({ manifest: manifest([{ ...manifest().panes[0],
    holds: [{ reason: "secondary", from: AT + 20_000, until: AT + 25_000 }] }]),
    storePath: "/unused/acquisition.json", now: () => at, readStore: () => current,
    inspectLock: () => ({ status: "unobstructed", ageMs: null }), emit: () => {} });
  assert.equal(monitor.sample().panes[0].state, "held");
  at = AT + 46_000;
  assert.equal(monitor.sample().panes[0].state, "overdue");
  assert.deepEqual(monitor.summary().panes[0].holdIntervals,
    [{ reason: "secondary", from: AT + 20_000, until: AT + 25_000 }]);
});

test("a report with zero validated successes remains unmeasured even before its first deadline", () => {
  const monitor = createFreshnessMonitor({ manifest: manifest(), storePath: "/unused/acquisition.json",
    now: () => AT + 1_000, readStore: () => store(),
    inspectLock: () => ({ status: "unobstructed", ageMs: null }), emit: () => {} });
  assert.equal(monitor.sample().panes[0].state, "awaiting-first");
  assert.equal(monitor.summary().ok, false);
  assert.equal(monitor.summary().panes[0].unmeasured, true);
});

test("missing and corrupt stores fail, while an explicit pane exit closes its expectation", () => {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-monitor-"));
  try {
    const storePath = join(root, "acquisition.json");
    let at = AT;
    const monitor = createFreshnessMonitor({ manifest: manifest(), storePath, now: () => at,
      inspectLock: () => ({ status: "unobstructed", ageMs: null }), emit: () => {} });
    assert.equal(monitor.sample().panes[0].state, "missing-store");
    writeFileSync(storePath, "{broken json\n");
    assert.equal(monitor.sample().panes[0].state, "corrupt-store");
    monitor.updateManifest(manifest([{ ...manifest().panes[0], exitedAt: AT + 1_000 }]));
    at += 1_000;
    assert.equal(monitor.sample().panes[0].state, "exited");
    assert.equal(monitor.summary().panes[0].exitedAt, at);
    assert.equal(monitor.summary().ok, false, "earlier missing/corrupt observations remain failures");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the default reader accepts validated shared publications and never rewrites the store", async () => {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-monitor-real-"));
  let at = AT;
  const engine = createAcquisitionEngine({ pathOptions: { env: { XDG_CONFIG_HOME: root } },
    now: () => at });
  try {
    const subscription = engine.subscribe({ host: "github.com", repositoryId: "R_widget",
      repository: "acme/widget", accessKey: "a".repeat(64), targetKey: "github.com\0R_widget",
      resource: "actions", queryVersion: 1, filters: {}, pageSize: 60,
      cursorGeneration: "first" }, { active: true, floorMs: 5_000 });
    assert.equal(subscription.ok, true);
    const path = acquisitionStorePath({ env: { XDG_CONFIG_HOME: root } });
    const monitor = createFreshnessMonitor({ manifest: manifest([{ id: "real fixture", pid: process.pid,
      repository: "acme/widget", tab: "actions", startedAt: AT, cadenceMs: 5_000 }]),
    storePath: path, now: () => at, emit: () => {},
    inspectLock: () => ({ status: "unobstructed", ageMs: null }) });
    const publication = (successAt, changedAt) => ({
      rows: [{ databaseId: 1, displayTitle: "same row", workflowName: "CI", number: 1,
        headBranch: "develop", status: "completed", conclusion: "success",
        startedAt: "2026-09-05T00:00:00Z", updatedAt: "2026-09-05T00:01:00Z",
        url: "https://github.com/acme/widget/actions/runs/1" }],
      pageInfo: null, raw: "[]", entities: [], lastSuccessAt: successAt,
      lastChangedAt: changedAt, nextDueAt: successAt + 5_000, hold: null,
      capabilities: {}, meta: { at: changedAt, truncated: false },
      securityNotes: [], securityBlind: false,
    });
    at += 1_000;
    assert.equal((await engine.refresh(subscription.value.id, {
      acquire: async () => publication(at, at) })).ok, true);
    assert.equal(monitor.sample().panes[0].lastSuccessAt, at);
    const changedAt = at;
    at += 5_000;
    assert.equal((await engine.refresh(subscription.value.id, { force: true,
      acquire: async () => publication(at, changedAt) })).ok, true);
    const before = readFileSync(path, "utf8");
    const observed = monitor.sample();
    assert.equal(observed.panes[0].lastSuccessAt, at);
    assert.equal(observed.panes[0].lastChangedAt, changedAt);
    assert.equal(readFileSync(path, "utf8"), before);
  } finally {
    engine.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the one-shot CLI writes redacted JSONL and exits nonzero for an absent store", async () => {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-monitor-cli-"));
  try {
    const manifestPath = join(root, "expected.json");
    const reportPath = join(root, "freshness.jsonl");
    writeFileSync(manifestPath, JSON.stringify(manifest([{ ...manifest().panes[0],
      startedAt: Date.now(), pid: process.pid }])), { mode: 0o600 });
    const code = await main(["--manifest", manifestPath, "--store", join(root, "missing.json"),
      "--report", reportPath, "--once"]);
    assert.equal(code, 1);
    const lines = readFileSync(reportPath, "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(lines.map((line) => line.type), ["sample", "summary"]);
    assert.equal(lines[0].panes[0].state, "missing-store");
    assert.equal(lines[1].ok, false);
    assert.equal(readFileSync(reportPath, "utf8").includes(SECRET), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("qualification CLI rejects early SIGINT after a valid source and records incomplete duration", async () => {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-monitor-sigint-"));
  const engine = createAcquisitionEngine({ pathOptions: { env: { XDG_CONFIG_HOME: root } },
    now: Date.now });
  try {
    const at = Date.now();
    const candidatePath = join(root, "candidate.tgz");
    writeFileSync(candidatePath, "candidate bytes", { mode: 0o600 });
    const candidateHash = createHash("sha256").update(readFileSync(candidatePath)).digest("hex");
    const subscribed = engine.subscribe({ host: "github.com", repositoryId: "R_widget",
      repository: "acme/widget", accessKey: ACCESS_IDENTITY,
      targetKey: "github.com\0R_widget", resource: "actions", queryVersion: 1,
      filters: {}, pageSize: 60, cursorGeneration: "first" },
    { active: true, floorMs: 5_000 });
    assert.equal(subscribed.ok, true);
    const successAt = Date.now();
    assert.equal((await engine.refresh(subscribed.value.id, { acquire: async () => ({
      rows: [], pageInfo: null, raw: "[]", entities: [], lastSuccessAt: successAt,
      lastChangedAt: successAt, nextDueAt: successAt + 5_000, hold: null,
      capabilities: {}, meta: { at: successAt, truncated: false },
      securityNotes: [], securityBlind: false,
    }) })).ok, true);
    const manifestPath = join(root, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify(qualificationManifest({ candidateHash,
      requestedDurationMs: 30_000,
      panes: [{ id: "live", pid: process.pid, repository: "acme/widget",
        repositoryId: "R_widget", host: "github.com", accessKey: ACCESS_IDENTITY,
        tab: "actions", startedAt: at - 1_000, cadenceMs: 5_000 }],
    })), { mode: 0o600 });
    const quotaKey = "c".repeat(64);
    const quotaPath = join(root, `quota-${quotaKey}.json`);
    writeFileSync(quotaPath, `${JSON.stringify(emptyGovernorState())}\n`, { mode: 0o600 });
    writeFileSync(join(root, "registry.json"), JSON.stringify({ identities: {
      fixture: { host: "github.com", accessKey: ACCESS_IDENTITY, quotaKey },
    } }), { mode: 0o600 });
    const quotaBefore = readFileSync(quotaPath, "utf8");
    const reportPath = join(root, "report.jsonl");
    setTimeout(() => process.emit("SIGINT"), 20);
    const code = await main(["--manifest", manifestPath,
      "--store", acquisitionStorePath({ env: { XDG_CONFIG_HOME: root } }),
      "--quota", quotaPath, "--candidate", candidatePath,
      "--report", reportPath, "--duration-ms", "30000"]);
    const lines = readFileSync(reportPath, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(code, 1);
    assert.equal(lines[0].panes[0].state, "eligible");
    assert.equal(lines.at(-1).qualifying, true);
    assert.equal(lines.at(-1).windowClass, "short");
    assert.equal(lines.at(-1).ok, false);
    assert.ok(lines.at(-1).actualElapsedMs < 30_000);
    assert.equal(readFileSync(quotaPath, "utf8"), quotaBefore);
    const completedPath = join(root, "completed.jsonl");
    writeFileSync(manifestPath, JSON.stringify(qualificationManifest({ candidateHash,
      requestedDurationMs: 1_000,
      panes: [{ id: "live", pid: process.pid, repository: "acme/widget",
        repositoryId: "R_widget", host: "github.com", accessKey: ACCESS_IDENTITY,
        tab: "actions", startedAt: at - 1_000, cadenceMs: 5_000 }],
    })), { mode: 0o600 });
    const completedCode = await main(["--manifest", manifestPath,
      "--store", acquisitionStorePath({ env: { XDG_CONFIG_HOME: root } }),
      "--quota", quotaPath, "--candidate", candidatePath,
      "--report", completedPath, "--duration-ms", "1000"]);
    const completed = readFileSync(completedPath, "utf8").trim().split("\n").map(JSON.parse).at(-1);
    assert.equal(completedCode, 0, JSON.stringify(completed));
    assert.equal(completed.ok, true);
    assert.equal(completed.windowClass, "short");
    assert.ok(completed.actualElapsedMs >= 1_000);
  } finally {
    engine.close();
    rmSync(root, { recursive: true, force: true });
  }
});
