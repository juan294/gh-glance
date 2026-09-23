import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { acquisitionStorePath, GOVERNOR_LOCK_ORPHAN_MS } from "../../index.mjs";

const execFileAsync = promisify(execFile);
const WORKER = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "acquisition-worker.mjs");

const query = {
  host: "github.com",
  repositoryId: "R_widget",
  repository: "acme/widget",
  accessKey: "a".repeat(64),
  targetKey: "github.com\0R_widget",
  resource: "actions",
  queryVersion: 2,
  filters: {},
  pageSize: 60,
  cursorGeneration: "first",
};

function snapshot() {
  const at = Date.now();
  const rows = [{ databaseId: 1, displayTitle: "shared process result", workflowName: "CI", number: 1,
    headBranch: "develop", status: "completed", conclusion: "success",
    startedAt: "2026-09-05T00:00:00Z", updatedAt: "2026-09-05T00:01:00Z",
    url: "https://github.com/acme/widget/actions/runs/1" }];
  return {
    rows,
    pageInfo: null,
    raw: JSON.stringify(rows),
    entities: [{ key: "actions\0runs", etag: "\"runs-v1\"", body: JSON.stringify(rows) }],
    lastSuccessAt: at,
    lastChangedAt: at,
    nextDueAt: at + 40_000,
    hold: null,
    capabilities: {},
    meta: { at: Date.now(), truncated: false },
    securityNotes: [],
    securityBlind: false,
  };
}

async function waitForWorkers(path, count) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (readdirSync(path).length === count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`only ${readdirSync(path).length}/${count} acquisition workers became ready`);
}

async function waitForPath(path, description) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`${description} did not appear before the deadline`);
}

test("SHARE-01: twelve separate panes elect one acquisition producer", { timeout: 20_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-shared-pty-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const readyDir = join(root, "ready");
  const goPath = join(root, "go");
  mkdirSync(readyDir);
  const workers = Array.from({ length: 12 }, (_, index) => execFileAsync(
    process.execPath,
    [WORKER, JSON.stringify({ root, readyDir, goPath, worker: String(index), operation: "refresh",
      query, snapshot: snapshot() })],
    { timeout: 15_000 },
  ));
  await waitForWorkers(readyDir, workers.length);
  writeFileSync(goPath, "go\n", { mode: 0o600 });
  const outcomes = (await Promise.all(workers)).map(({ stdout }) => JSON.parse(stdout));
  assert.equal(outcomes.filter((outcome) => outcome.value?.role === "producer").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.value?.role === "follower").length, 11,
    JSON.stringify(outcomes));
  assert.ok(outcomes.every((outcome) => outcome.ok));
  assert.ok(outcomes.every((outcome) =>
    outcome.value.snapshot.rows[0].displayTitle === "shared process result"));
});

test("SHARE-01: simultaneous same-query refreshes recover an aged empty acquisition lock", { timeout: 25_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-orphan-refresh-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const storePath = acquisitionStorePath({ env: { XDG_CONFIG_HOME: root } });
  const lockPath = `${storePath}.lock`;
  const readyDir = join(root, "ready");
  const goPath = join(root, "go");
  mkdirSync(readyDir);
  const published = snapshot();
  const deadline = Date.now() + 10_000;
  const workers = Array.from({ length: 8 }, (_, index) => execFileAsync(process.execPath,
    [WORKER, JSON.stringify({ root, readyDir, goPath, worker: String(index), operation: "refresh",
      query, snapshot: published })], { timeout: 12_000 }));
  await waitForWorkers(readyDir, workers.length);
  writeFileSync(lockPath, "", { mode: 0o600 });
  const aged = new Date(Date.now() - GOVERNOR_LOCK_ORPHAN_MS - 1_000);
  utimesSync(lockPath, aged, aged);
  writeFileSync(goPath, "go\n", { mode: 0o600 });
  const outcomes = (await Promise.all(workers)).map(({ stdout }) => JSON.parse(stdout));
  assert.ok(Date.now() < deadline, "orphan recovery and publication exceeded the wall-clock deadline");
  assert.equal(outcomes.filter((outcome) => outcome.value?.role === "producer").length, 1,
    JSON.stringify(outcomes));
  assert.equal(outcomes.filter((outcome) => outcome.value?.role === "follower").length, 7,
    JSON.stringify(outcomes));
  assert.ok(outcomes.every((outcome) => outcome.ok &&
    outcome.value.snapshot.rows[0].displayTitle === "shared process result"));
  assert.equal(statSync(dirname(lockPath)).mode & 0o777, 0o700);
  assert.equal(statSync(storePath).mode & 0o777, 0o600);
  assert.equal(existsSync(lockPath), false);
});

test("SHARE-01: an open-before-write creator cannot remove a successor during two-recoverer race", { timeout: 25_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-stalled-creator-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lockPath = `${acquisitionStorePath({ env: { XDG_CONFIG_HOME: root } })}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const openPath = join(root, "opened");
  const resumePath = join(root, "resume");
  const creator = execFileAsync(process.execPath, [WORKER, JSON.stringify({ operation: "stalledCreator",
    lockPath, openPath, resumePath, nonce: "stalled-creator" })], { timeout: 12_000 });
  await waitForPath(openPath, "stalled creator lock");
  assert.equal(statSync(lockPath).size, 0);
  assert.equal(statSync(lockPath).mode & 0o777, 0o600);
  const aged = new Date(Date.now() - GOVERNOR_LOCK_ORPHAN_MS - 1_000);
  utimesSync(lockPath, aged, aged);
  const readyDir = join(root, "ready");
  const goPath = join(root, "go");
  const criticalPath = join(root, "critical");
  const releasePath = join(root, "release-successor");
  mkdirSync(readyDir);
  const recoverers = Array.from({ length: 2 }, (_, index) => execFileAsync(process.execPath,
    [WORKER, JSON.stringify({ operation: "lock", lockPath, readyDir, goPath,
      worker: String(index), criticalPath, holdUntilPath: releasePath, waitMs: 5_000 })],
    { timeout: 12_000 }));
  await waitForWorkers(readyDir, recoverers.length);
  writeFileSync(goPath, "go\n", { mode: 0o600 });
  await waitForPath(criticalPath, "successor critical section");
  writeFileSync(resumePath, "resume\n", { mode: 0o600 });
  const creatorResult = JSON.parse((await creator).stdout);
  assert.equal(creatorResult.claim, "held");
  assert.notEqual(creatorResult.successor.nonce, "stalled-creator");
  assert.equal(statSync(lockPath).mode & 0o777, 0o600);
  writeFileSync(releasePath, "release\n", { mode: 0o600 });
  const outcomes = (await Promise.all(recoverers)).map(({ stdout }) => JSON.parse(stdout));
  assert.ok(outcomes.every((outcome) => outcome.ok && outcome.value?.overlap === false),
    JSON.stringify(outcomes));
  assert.equal(statSync(dirname(lockPath)).mode & 0o777, 0o700);
  assert.equal(existsSync(lockPath), false);
  assert.equal(existsSync(criticalPath), false);
});

test("SHARE-01: concurrent recovery of an aged empty lock keeps critical sections exclusive and permits later publication", { timeout: 25_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-recover-pty-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lockPath = `${acquisitionStorePath({ env: { XDG_CONFIG_HOME: root } })}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  writeFileSync(lockPath, "", { mode: 0o600 });
  const aged = new Date(Date.now() - GOVERNOR_LOCK_ORPHAN_MS - 1_000);
  utimesSync(lockPath, aged, aged);
  const readyDir = join(root, "ready-lock");
  const goPath = join(root, "go-lock");
  const criticalPath = join(root, "critical");
  mkdirSync(readyDir);
  const deadline = Date.now() + 10_000;
  const workers = Array.from({ length: 8 }, (_, index) => execFileAsync(process.execPath,
    [WORKER, JSON.stringify({ root, readyDir, goPath, worker: String(index), operation: "lock",
      lockPath, criticalPath })], { timeout: 10_000 }));
  await waitForWorkers(readyDir, workers.length);
  writeFileSync(goPath, "go\n", { mode: 0o600 });
  const outcomes = (await Promise.all(workers)).map(({ stdout }) => JSON.parse(stdout));
  assert.ok(Date.now() < deadline, "orphan recovery must finish within the wall-clock deadline");
  assert.ok(outcomes.every((outcome) => outcome.ok && outcome.value?.overlap === false),
    JSON.stringify(outcomes));
  assert.equal(statSync(dirname(lockPath)).mode & 0o777, 0o700);
  assert.ok(outcomes.every((outcome) => outcome.modes.canonical === 0o600));
  assert.ok(outcomes.some((outcome) => outcome.modes.recovery === 0o600 &&
    outcome.modes.quarantine === 0o600));
  assert.equal(existsSync(lockPath), false);
  assert.equal(existsSync(criticalPath), false);

  const published = snapshot();
  const refreshReadyDir = join(root, "ready-refresh");
  const refreshGoPath = join(root, "go-refresh");
  mkdirSync(refreshReadyDir);
  const refreshing = Array.from({ length: 8 }, (_, index) => execFileAsync(process.execPath,
    [WORKER, JSON.stringify({ root, readyDir: refreshReadyDir, goPath: refreshGoPath,
      worker: String(index), operation: "refresh", query, snapshot: published })],
    { timeout: 10_000 }));
  await waitForWorkers(refreshReadyDir, refreshing.length);
  writeFileSync(refreshGoPath, "go\n", { mode: 0o600 });
  const shared = (await Promise.all(refreshing)).map(({ stdout }) => JSON.parse(stdout));
  assert.equal(shared.filter((outcome) => outcome.value?.role === "producer").length, 1);
  assert.equal(shared.filter((outcome) => outcome.value?.role === "follower").length, 7,
    JSON.stringify(shared));
  assert.ok(shared.every((outcome) => outcome.ok &&
    outcome.value.snapshot.rows[0].displayTitle === "shared process result"));
  const second = await execFileAsync(process.execPath, [WORKER, JSON.stringify({ root, operation: "refresh",
    query: { ...query, queryVersion: query.queryVersion + 1 }, snapshot: published })], { timeout: 10_000 });
  assert.equal(JSON.parse(second.stdout).value?.role, "producer");
  assert.equal(existsSync(lockPath), false);
});
