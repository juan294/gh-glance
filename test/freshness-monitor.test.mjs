import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { acquisitionStorePath, createAcquisitionEngine } from "../index.mjs";
import { createFreshnessMonitor, main } from "../scripts/freshness-monitor.mjs";

const AT = 1_800_000_000_000;
const SECRET = "private/acme-repository";
const QUERY_KEY = "sensitive-query-key";
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
        accessKey: "never-log-this-access-key" },
      snapshot: successAt === null ? null : {
        lastSuccessAt: successAt, lastChangedAt: changedAt, nextDueAt: successAt + 5_000,
      },
      hold: null,
    } },
  } };
}

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
